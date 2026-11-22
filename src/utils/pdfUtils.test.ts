import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePageRanges,
  splitRangesIntoGroups,
  formatBytes,
  computeSavingsPercent,
  computeTextDiff,
  parseMarkdownToBlocks,
  stripHtmlToBlocks,
  parseCsvRows,
} from './pdfUtils';
import {
  buildDeviceProfile,
  inspectFileHeaderBytes,
  assessWorkloadRisk,
} from './preflight';

test('parsePageRanges handles single pages, ranges, reverse ranges, and bounds errors', () => {
  assert.deepEqual(parsePageRanges('1-3, 5, 8-9', 10), { pages: [1, 2, 3, 5, 8, 9] });
  assert.deepEqual(parsePageRanges('3-1', 5), { pages: [3, 2, 1] });
  assert.deepEqual(parsePageRanges('', 4), { pages: [1, 2, 3, 4] });
  const oob = parsePageRanges('1, 12', 10);
  assert.ok(oob.error && oob.error.includes('out of bounds'));
  const bad = parsePageRanges('abc', 10);
  assert.ok(bad.error && bad.error.includes('Invalid page syntax'));
});

test('splitRangesIntoGroups builds distinct PDF page arrays per comma group', () => {
  const res = splitRangesIntoGroups('1-2, 4, 5-6', 6);
  assert.equal(res.error, undefined);
  assert.deepEqual(res.groups, [[1, 2], [4], [5, 6]]);
});

test('formatBytes and computeSavingsPercent format human sizes accurately', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.00 KB');
  assert.equal(formatBytes(250 * 1024 * 1024), '250 MB');
  assert.equal(computeSavingsPercent(1000, 400), 60);
  assert.equal(computeSavingsPercent(1000, 1100), -10);
});

test('computeTextDiff identifies unchanged, added, and removed lines', () => {
  const diff = computeTextDiff('Line 1\nLine 2\nLine 3', 'Line 1\nLine 2 revised\nLine 3\nLine 4');
  assert.equal(diff.unchangedCount, 2);
  assert.equal(diff.removedCount, 1);
  assert.equal(diff.addedCount, 2);
});

test('parseMarkdownToBlocks, stripHtmlToBlocks, and parseCsvRows parse structured content', () => {
  const md = parseMarkdownToBlocks('# Title\n\nHello **world**\n- Item A\n---');
  assert.deepEqual(
    md.map((b) => b.type),
    ['heading', 'paragraph', 'bullet', 'divider'],
  );
  assert.equal(md[1].text, 'Hello world');

  const html = stripHtmlToBlocks('<h1>Invoice</h1><p>Total &amp; Tax</p><li>Row 1</li>');
  assert.equal(html[0].type, 'heading');
  assert.equal(html[0].text, 'Invoice');
  assert.equal(html[1].text, 'Total & Tax');

  const rows = parseCsvRows('Name,Amount\n"Smith, Jane",120\nBob,45');
  assert.deepEqual(rows, [
    ['Name', 'Amount'],
    ['Smith, Jane', '120'],
    ['Bob', '45'],
  ]);
});

test('inspectFileHeaderBytes detects valid PDF, encrypted PDF, corrupted file, PNG, and empty file', () => {
  const encoder = new TextEncoder();
  const validPdf = inspectFileHeaderBytes(encoder.encode('%PDF-1.7\n1 0 obj'), null, 'doc.pdf', 1024);
  assert.equal(validPdf.detectedType, 'pdf');
  assert.equal(validPdf.hasValidPdfHeader, true);
  assert.equal(validPdf.isEncryptedPdf, false);

  const encPdf = inspectFileHeaderBytes(
    encoder.encode('%PDF-1.7\n'),
    encoder.encode('trailer << /Size 10 /Encrypt 9 0 R >>'),
    'locked.pdf',
    2048,
  );
  assert.equal(encPdf.isEncryptedPdf, true);

  const corrupted = inspectFileHeaderBytes(encoder.encode('NOT A PDF FILE'), null, 'broken.pdf', 100);
  assert.equal(corrupted.hasValidPdfHeader, false);

  const png = inspectFileHeaderBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), null, 'img.png', 500);
  assert.equal(png.detectedType, 'png');

  const empty = inspectFileHeaderBytes(new Uint8Array([]), null, 'empty.pdf', 0);
  assert.equal(empty.detectedType, 'empty');
});

test('assessWorkloadRisk flags crash risk on low-RAM mobile while staying ok for same file on 16GB desktop', () => {
  const MB = 1024 * 1024;
  const mobile2Gb = buildDeviceProfile({
    deviceMemoryGb: 2,
    hardwareConcurrency: 4,
    isMobile: true,
    jsHeapLimitBytes: null,
  });
  const desktop16Gb = buildDeviceProfile({
    deviceMemoryGb: 16,
    hardwareConcurrency: 12,
    isMobile: false,
    jsHeapLimitBytes: null,
  });

  const probe120Mb = {
    fileName: 'scan.pdf',
    sizeBytes: 120 * MB,
    detectedType: 'pdf' as const,
    isEncryptedPdf: false,
    hasValidPdfHeader: true,
  };

  // Same 120MB file in PDF-to-Images (7.5x multiplier => ~900MB peak):
  const mobileRisk = assessWorkloadRisk({
    probes: [probe120Mb],
    toolId: 'pdf-to-images',
    otherTabsBytes: 0,
    device: mobile2Gb,
  });
  assert.equal(mobileRisk.level, 'high-risk');

  // On 16GB desktop with Merge (2.6x multiplier => ~312MB peak), completely safe:
  const desktopRisk = assessWorkloadRisk({
    probes: [probe120Mb],
    toolId: 'merge',
    otherTabsBytes: 0,
    device: desktop16Gb,
  });
  assert.equal(desktopRisk.level, 'ok');

  // Corrupted PDF gets flagged as unprocessable immediately:
  const brokenRisk = assessWorkloadRisk({
    probes: [
      {
        fileName: 'corrupt.pdf',
        sizeBytes: 5000,
        detectedType: 'text',
        isEncryptedPdf: false,
        hasValidPdfHeader: false,
      },
    ],
    toolId: 'split',
    otherTabsBytes: 0,
    device: desktop16Gb,
  });
  assert.equal(brokenRisk.level, 'unprocessable');
});
