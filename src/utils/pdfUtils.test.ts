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
  normalizeWebpageUrl,
  extractHtmlTitle,
  parseJinaReaderResponse,
  classifyPdfFontStyle,
  mergeRawTextRunsIntoEditableLines,
  findMatchingTextLineSlices,
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

  // Same 120MB file in PDF-to-Images (7.5x multiplier => ~900MB peak) on 2GB mobile (286MB budget => >135%):
  const mobileRisk = assessWorkloadRisk({
    probes: [probe120Mb],
    toolId: 'pdf-to-images',
    otherTabsBytes: 0,
    device: mobile2Gb,
  });
  assert.equal(mobileRisk.level, 'crash-imminent');
  assert.ok(mobileRisk.estimatedComputeSeconds > 0);
  assert.ok(mobileRisk.computeLabel.includes('CPU'));

  // On 16GB desktop with Merge (2.6x multiplier => ~312MB peak), completely safe:
  const desktopRisk = assessWorkloadRisk({
    probes: [probe120Mb],
    toolId: 'merge',
    otherTabsBytes: 0,
    device: desktop16Gb,
  });
  assert.equal(desktopRisk.level, 'ok');

  // Extreme 600MB file in Compress PDF (6.5x => 3.9GB vs 2.4GB budget) triggers red crash-imminent even on 16GB desktop:
  const extremeDesktopRisk = assessWorkloadRisk({
    probes: [{ ...probe120Mb, sizeBytes: 600 * MB }],
    toolId: 'compress',
    otherTabsBytes: 0,
    device: desktop16Gb,
  });
  assert.equal(extremeDesktopRisk.level, 'crash-imminent');

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

test('normalizeWebpageUrl validates protocols, auto-prepends https, and detects private hosts', () => {
  const bare = normalizeWebpageUrl('example.com/docs');
  assert.equal(bare.error, undefined);
  assert.equal(bare.url, 'https://example.com/docs');
  assert.equal(bare.isPrivateHost, false);

  const httpsOk = normalizeWebpageUrl('https://en.wikipedia.org/wiki/PDF');
  assert.equal(httpsOk.url, 'https://en.wikipedia.org/wiki/PDF');
  assert.equal(httpsOk.isPrivateHost, false);

  const jsBlocked = normalizeWebpageUrl('javascript:alert(1)');
  assert.ok(jsBlocked.error && jsBlocked.error.includes('Unsupported URL protocol'));

  const dataBlocked = normalizeWebpageUrl('data:text/html,<h1>x</h1>');
  assert.ok(dataBlocked.error && dataBlocked.error.includes('Unsupported URL protocol'));

  const fileBlocked = normalizeWebpageUrl('file:///etc/passwd');
  assert.ok(fileBlocked.error && fileBlocked.error.includes('Unsupported URL protocol'));

  const credsBlocked = normalizeWebpageUrl('https://user:pass@example.com');
  assert.ok(credsBlocked.error && credsBlocked.error.includes('credentials'));

  const local = normalizeWebpageUrl('http://localhost:3000/page');
  assert.equal(local.error, undefined);
  assert.equal(local.isPrivateHost, true);

  const lan = normalizeWebpageUrl('http://192.168.1.42/status');
  assert.equal(lan.error, undefined);
  assert.equal(lan.isPrivateHost, true);
});

test('extractHtmlTitle, parseJinaReaderResponse, and upgraded stripHtmlToBlocks extract clean content safely', () => {
  const html = `<!doctype html><html><head><title>Spec &mdash; FolioPDF</title><style>.a{color:red}</style></head>
    <body>
      <nav><a href="/">Home</a></nav>
      <script>alert('xss')</script>
      <!-- secret comment -->
      <svg><text>svg-noise</text></svg>
      <main>
        <h1>Quarterly Report</h1>
        <p>Revenue grew &amp; margins held steady&#33;</p>
      </main>
      <footer>Copyright 2026</footer>
    </body></html>`;

  assert.equal(extractHtmlTitle(html), 'Spec - FolioPDF');
  const blocks = stripHtmlToBlocks(html);
  assert.equal(blocks[0].type, 'heading');
  assert.equal(blocks[0].text, 'Quarterly Report');
  assert.equal(blocks[1].text, 'Revenue grew & margins held steady!');
  assert.ok(!blocks.some((b) => b.text.includes('alert') || b.text.includes('svg-noise') || b.text.includes('Copyright')));

  const jinaRaw = `Title: Example Domain\nURL Source: https://example.com/\nWarning: cached snapshot\nMarkdown Content:\nThis domain is for [documentation](https://iana.org) ![img](https://example.com/a.png).\n| Col A | Col B |\n| --- | --- |\n| Val 1 | Val 2 |`;
  const parsed = parseJinaReaderResponse(jinaRaw, 'https://example.com/');
  assert.equal(parsed.title, 'Example Domain');
  assert.ok(!parsed.markdown.includes('Warning: cached snapshot'));

  const mdBlocks = parseMarkdownToBlocks(parsed.markdown);
  assert.equal(mdBlocks[0].type, 'heading');
  assert.equal(mdBlocks[0].text, 'Example Domain');
  assert.ok(mdBlocks.some((b) => b.text.includes('This domain is for documentation')));
  assert.ok(!mdBlocks.some((b) => b.text.includes('https://iana.org')));
  assert.ok(!mdBlocks.some((b) => b.text.includes('---')));
});

test('classifyPdfFontStyle, mergeRawTextRunsIntoEditableLines, and findMatchingTextLineSlices', () => {
  assert.deepEqual(classifyPdfFontStyle('TimesNewRomanPS-BoldItalicMT'), {
    fontFamily: 'serif',
    isBold: true,
    isItalic: true,
  });
  assert.deepEqual(classifyPdfFontStyle('CourierNew-Bold'), {
    fontFamily: 'mono',
    isBold: true,
    isItalic: false,
  });

  const merged = mergeRawTextRunsIntoEditableLines(
    [
      { str: 'Invoice', x: 0.1, y: 0.1, width: 0.08, height: 0.02, fontSizePt: 12, fontName: 'Helvetica-Bold' },
      { str: '#4091', x: 0.188, y: 0.1, width: 0.07, height: 0.02, fontSizePt: 12, fontName: 'Helvetica-Bold' },
      // Distant right column on same row should remain separate
      { str: '$1,250.00', x: 0.78, y: 0.1, width: 0.1, height: 0.02, fontSizePt: 12, fontName: 'Helvetica' },
      { str: 'Client: Acme Corp', x: 0.1, y: 0.16, width: 0.22, height: 0.018, fontSizePt: 11, fontName: 'Helvetica' },
    ],
    0,
  );

  assert.equal(merged.length, 3);
  assert.equal(merged[0].text, 'Invoice #4091');
  assert.equal(merged[0].isBold, true);
  assert.equal(merged[1].text, '$1,250.00');
  assert.equal(merged[2].text, 'Client: Acme Corp');

  const matches = findMatchingTextLineSlices(merged, 'acme');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].matchText, 'Acme');
  assert.ok(matches[0].x > merged[2].x);
  assert.ok(matches[0].width < merged[2].width);
});
