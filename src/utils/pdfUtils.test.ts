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
import JSZip from 'jszip';
import {
  buildDeviceProfile,
  inspectFileHeaderBytes,
  assessWorkloadRisk,
} from './preflight';
import {
  extractBlocksFromLegacyDoc,
  extractRichSlidesFromLegacyPpt,
  extractSheetsFromLegacyXls,
  extractSlidesFromLegacyPpt,
  parseEnhancedDocxXml,
  parseOdpContentXml,
  parseOdtContentXml,
  parseOle2Streams,
  parseRichOdpXml,
  parseRtfToBlocks,
} from './legacyOfficeUtils';
import { parsePptxArchive } from './pptxParser';
import {
  buildEditablePptxBlob,
  buildXlsxBlob,
  columnIndexToExcelRef,
  excelColRefToIndex,
  groupPdfLinesIntoSheetRows,
  parseOdsContentXml,
  parsePptxSlideXml,
  parseXlsxSharedStringsXml,
  parseXlsxWorksheetXml,
  rowsToCsv,
} from './officeUtils';

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

test('XLSX and ODS utilities parse sheets and round-trip buildXlsxBlob cleanly', async () => {
  assert.equal(columnIndexToExcelRef(0), 'A');
  assert.equal(columnIndexToExcelRef(25), 'Z');
  assert.equal(columnIndexToExcelRef(26), 'AA');
  assert.equal(excelColRefToIndex('A1'), 0);
  assert.equal(excelColRefToIndex('AA14'), 26);

  const shared = parseXlsxSharedStringsXml(
    '<sst><si><t>Department</t></si><si><t>Budget &amp; Ops</t></si></sst>',
  );
  assert.deepEqual(shared, ['Department', 'Budget & Ops']);

  const parsedGrid = parseXlsxWorksheetXml(
    `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
      <row r="2"><c r="A2" t="inlineStr"><is><t>Engineering</t></is></c><c r="B2"><v>42500</v></c></row>
    </sheetData></worksheet>`,
    shared,
  );
  assert.deepEqual(parsedGrid, [
    ['Department', 'Budget & Ops'],
    ['Engineering', '42500'],
  ]);

  const odsSheets = parseOdsContentXml(
    `<office:spreadsheet>
      <table:table table:name="Q4 Forecast">
        <table:table-row>
          <table:table-cell><text:p>Region</text:p></table:table-cell>
          <table:table-cell><text:p>Units</text:p></table:table-cell>
        </table:table-row>
        <table:table-row>
          <table:table-cell><text:p>APAC</text:p></table:table-cell>
          <table:table-cell><text:p>910</text:p></table:table-cell>
        </table:table-row>
      </table:table>
    </office:spreadsheet>`,
  );
  assert.equal(odsSheets.length, 1);
  assert.equal(odsSheets[0].name, 'Q4 Forecast');
  assert.deepEqual(odsSheets[0].rows, [
    ['Region', 'Units'],
    ['APAC', '910'],
  ]);

  // Round-trip buildXlsxBlob -> JSZip -> parseXlsxWorksheetXml
  const xlsxBlob = await buildXlsxBlob([
    {
      name: 'Revenue:Q4/2026',
      rows: [
        ['Region', 'Revenue', 'Margin'],
        ['North', '128000', '24.5'],
        ['South', '94500', '21.0'],
      ],
    },
  ]);
  const zip = await JSZip.loadAsync(await xlsxBlob.arrayBuffer());
  assert.ok(zip.file('[Content_Types].xml'));
  assert.ok(zip.file('xl/workbook.xml'));
  assert.ok(zip.file('xl/styles.xml'));
  const sheetXml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
  const roundTripped = parseXlsxWorksheetXml(sheetXml, []);
  assert.deepEqual(roundTripped, [
    ['Region', 'Revenue', 'Margin'],
    ['North', '128000', '24.5'],
    ['South', '94500', '21.0'],
  ]);
});

test('PPTX utilities build valid OOXML deck and parse slide shapes, tables, and PDF table rows', async () => {
  const pptxBlob = await buildEditablePptxBlob([
    {
      widthPt: 960,
      heightPt: 540,
      lines: [
        { text: 'Executive Summary 2026', x: 0.08, y: 0.1, width: 0.6, height: 0.08, fontSizePt: 26, isBold: true },
        { text: 'All tasks execute locally in-browser.', x: 0.08, y: 0.25, width: 0.7, height: 0.05, fontSizePt: 15 },
      ],
    },
  ]);
  const zip = await JSZip.loadAsync(await pptxBlob.arrayBuffer());
  assert.ok(zip.file('[Content_Types].xml'));
  assert.ok(zip.file('ppt/presentation.xml'));
  assert.ok(zip.file('ppt/slideMasters/slideMaster1.xml'));
  assert.ok(zip.file('ppt/slideLayouts/slideLayout1.xml'));
  assert.ok(zip.file('ppt/theme/theme1.xml'));
  const slideXml = await zip.file('ppt/slides/slide1.xml')!.async('string');
  const parsedSlide = parsePptxSlideXml(slideXml, 1);
  assert.equal(parsedSlide.shapes.length, 2);
  assert.equal(parsedSlide.shapes[0].paragraphs[0].text, 'Executive Summary 2026');
  assert.equal(parsedSlide.shapes[1].paragraphs[0].text, 'All tasks execute locally in-browser.');

  // Coordinate-aware PDF lines -> spreadsheet rows & RFC-4180 CSV
  const rows = groupPdfLinesIntoSheetRows([
    { id: '1', pageIndex: 0, text: 'Item', x: 0.1, y: 0.1, width: 0.15, height: 0.02, fontSizePt: 11, fontFamily: 'sans', isBold: true, isItalic: false },
    { id: '2', pageIndex: 0, text: 'Cost', x: 0.6, y: 0.1, width: 0.1, height: 0.02, fontSizePt: 11, fontFamily: 'sans', isBold: true, isItalic: false },
    { id: '3', pageIndex: 0, text: 'Widget, Pro', x: 0.1, y: 0.16, width: 0.2, height: 0.02, fontSizePt: 10, fontFamily: 'sans', isBold: false, isItalic: false },
    { id: '4', pageIndex: 0, text: '299', x: 0.6, y: 0.16, width: 0.08, height: 0.02, fontSizePt: 10, fontFamily: 'sans', isBold: false, isItalic: false },
  ]);
  assert.deepEqual(rows, [
    ['Item', 'Cost'],
    ['Widget, Pro', '299'],
  ]);
  assert.equal(rowsToCsv(rows), 'Item,Cost\r\n"Widget, Pro",299');

  // Preflight accepts .pptx, .xlsx, .ppt, .doc, .xls cleanly while flagging unknown binary files
  const desktop = buildDeviceProfile({ deviceMemoryGb: 16, hardwareConcurrency: 12, isMobile: false, jsHeapLimitBytes: null });
  const pptxRisk = assessWorkloadRisk({
    probes: [{ fileName: 'deck.pptx', sizeBytes: 250_000, detectedType: 'zip-or-docx', isEncryptedPdf: false, hasValidPdfHeader: false }],
    toolId: 'converter',
    otherTabsBytes: 0,
    device: desktop,
  });
  assert.equal(pptxRisk.level, 'ok');
  assert.equal(pptxRisk.issues.length, 0);

  const legacyXlsRisk = assessWorkloadRisk({
    probes: [{ fileName: 'old.xls', sizeBytes: 120_000, detectedType: 'ole2', isEncryptedPdf: false, hasValidPdfHeader: false }],
    toolId: 'converter',
    otherTabsBytes: 0,
    device: desktop,
  });
  assert.equal(legacyXlsRisk.level, 'ok');

  const unknownBinRisk = assessWorkloadRisk({
    probes: [{ fileName: 'archive.bin', sizeBytes: 120_000, detectedType: 'unknown', isEncryptedPdf: false, hasValidPdfHeader: false }],
    toolId: 'converter',
    otherTabsBytes: 0,
    device: desktop,
  });
  assert.equal(unknownBinRisk.level, 'caution');
});

function buildMinimalOle2File(streamName: string, streamData: Uint8Array): Uint8Array {
  // 512-byte sectors: sector 0 = FAT, sector 1 = Directory, sectors 2..N = stream data
  const streamSectors = Math.max(1, Math.ceil(streamData.length / 512));
  const totalSectors = 2 + streamSectors;
  const buf = new Uint8Array(512 + totalSectors * 512);
  const dv = new DataView(buf.buffer);

  // Header magic: D0 CF 11 E0 A1 B1 1A E1
  buf.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  dv.setUint16(24, 0x003e, true);
  dv.setUint16(26, 0x0003, true);
  dv.setUint16(28, 0xfffe, true);
  dv.setUint16(30, 9, true); // 512-byte sectors
  dv.setUint16(32, 6, true); // 64-byte mini sectors
  dv.setUint32(44, 1, true); // 1 FAT sector
  dv.setUint32(48, 1, true); // firstDirSector = 1
  dv.setUint32(56, 0, true); // miniCutoffSize = 0 (always regular FAT)
  dv.setUint32(60, 0xfffffffe, true); // no MiniFAT
  dv.setUint32(68, 0xfffffffe, true); // no extra DIFAT
  dv.setUint32(76, 0, true); // FAT is in sector 0
  for (let i = 1; i < 109; i++) dv.setUint32(76 + i * 4, 0xffffffff, true);

  // Sector 0: FAT
  const fatOff = 512;
  for (let i = 0; i < 128; i++) dv.setUint32(fatOff + i * 4, 0xffffffff, true);
  dv.setUint32(fatOff + 0 * 4, 0xfffffffd, true); // FATSECT
  dv.setUint32(fatOff + 1 * 4, 0xfffffffe, true); // Dir EOF
  for (let s = 0; s < streamSectors; s++) {
    dv.setUint32(
      fatOff + (2 + s) * 4,
      s + 1 < streamSectors ? 2 + s + 1 : 0xfffffffe,
      true,
    );
  }

  // Sector 1: Directory (entry 0 = Root Entry, entry 1 = streamName)
  const dirOff = 512 + 512;
  const writeDirName = (entryBase: number, name: string) => {
    for (let i = 0; i < name.length; i++) {
      dv.setUint16(entryBase + i * 2, name.charCodeAt(i), true);
    }
    dv.setUint16(entryBase + name.length * 2, 0, true);
    dv.setUint16(entryBase + 64, (name.length + 1) * 2, true);
  };
  writeDirName(dirOff, 'Root Entry');
  buf[dirOff + 66] = 5; // Root Storage
  dv.setUint32(dirOff + 116, 0xfffffffe, true);

  const e1 = dirOff + 128;
  writeDirName(e1, streamName);
  buf[e1 + 66] = 2; // Stream
  dv.setUint32(e1 + 116, 2, true); // startSec = 2
  dv.setUint32(e1 + 120, streamData.length, true);

  // Sectors 2..N: stream payload
  buf.set(streamData, 512 + 2 * 512);
  return buf;
}

test('Legacy Office (.ppt, .xls, .doc), RTF, ODT, ODP, and enhanced DOCX parsers extract clean structured data', () => {
  // 1. Build a real OLE2 .ppt binary with Slide container (0x03EE) + TextBytesAtom (0x0FA8)
  const encoder = new TextEncoder();
  const titleBytes = encoder.encode('Legacy Slide Deck');
  const bodyBytes = encoder.encode('Point one\rPoint two');
  const atom1Len = 8 + titleBytes.length;
  const atom2Len = 8 + bodyBytes.length;
  const slidePayloadLen = atom1Len + atom2Len;
  const pptStream = new Uint8Array(8 + slidePayloadLen);
  const pdv = new DataView(pptStream.buffer);
  pdv.setUint16(0, 0x000f, true); // container version
  pdv.setUint16(2, 0x03ee, true); // RT_Slide
  pdv.setUint32(4, slidePayloadLen, true);
  // Atom 1: TextBytesAtom
  pdv.setUint16(8, 0x0000, true);
  pdv.setUint16(10, 0x0fa8, true);
  pdv.setUint32(12, titleBytes.length, true);
  pptStream.set(titleBytes, 16);
  // Atom 2: TextBytesAtom
  const a2 = 8 + atom1Len;
  pdv.setUint16(a2, 0x0000, true);
  pdv.setUint16(a2 + 2, 0x0fa8, true);
  pdv.setUint32(a2 + 4, bodyBytes.length, true);
  pptStream.set(bodyBytes, a2 + 8);

  const olePpt = buildMinimalOle2File('PowerPoint Document', pptStream);
  const headerProbe = inspectFileHeaderBytes(olePpt.subarray(0, 64), null, 'legacy.ppt', olePpt.length);
  assert.equal(headerProbe.detectedType, 'ole2');
  const streams = parseOle2Streams(olePpt);
  assert.ok(streams.has('PowerPoint Document'));
  const slides = extractSlidesFromLegacyPpt(olePpt);
  assert.equal(slides.length, 1);
  assert.equal(slides[0].shapes[0].paragraphs[0].text, 'Legacy Slide Deck');
  assert.equal(slides[0].shapes[1].paragraphs[0].text, 'Point one');

  // 2. Legacy .xls (SpreadsheetML XML & HTML table variants)
  const xmlXls = encoder.encode(
    '<Workbook><Worksheet ss:Name="Sales"><Table><Row><Cell><Data>Product</Data></Cell><Cell><Data>Units</Data></Cell></Row><Row><Cell><Data>Pro</Data></Cell><Cell><Data>42</Data></Cell></Row></Table></Worksheet></Workbook>',
  );
  const xlsSheets = extractSheetsFromLegacyXls(xmlXls, 'sales');
  assert.equal(xlsSheets.length, 1);
  assert.equal(xlsSheets[0].name, 'Sales');
  assert.deepEqual(xlsSheets[0].rows, [
    ['Product', 'Units'],
    ['Pro', '42'],
  ]);

  // 3. RTF & RTF-disguised .doc
  const rtfStr = '{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}Hello \\b World\\b0\\par Second line with \\\'26 ampersand}';
  const rtfBlocks = parseRtfToBlocks(rtfStr);
  assert.equal(rtfBlocks.length, 2);
  assert.equal(rtfBlocks[0].text, 'Hello World');
  assert.equal(rtfBlocks[1].text, 'Second line with & ampersand');
  const docFromRtf = extractBlocksFromLegacyDoc(encoder.encode(rtfStr));
  assert.equal(docFromRtf[0].text, 'Hello World');

  // 4. ODT, ODP, and Enhanced DOCX (headings + bullets + tables)
  const odt = parseOdtContentXml(
    '<office:text><text:h text:outline-level="1">Spec</text:h><text:p>Body text</text:p><table:table><table:table-row><table:table-cell><text:p>A</text:p></table:table-cell><table:table-cell><text:p>B</text:p></table:table-cell></table:table-row></table:table></office:text>',
  );
  assert.equal(odt.blocks[0].type, 'heading');
  assert.equal(odt.tables.length, 1);

  const odp = parseOdpContentXml(
    '<draw:page draw:name="page1"><draw:frame presentation:class="title"><draw:text-box><text:p>ODP Heading</text:p></draw:text-box></draw:frame></draw:page>',
  );
  assert.equal(odp.length, 1);
  assert.equal(odp[0].shapes[0].paragraphs[0].text, 'ODP Heading');

  const docx = parseEnhancedDocxXml(
    '<w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Project Brief</w:t></w:r></w:p><w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>Bullet item</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Col1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Col2</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body>',
  );
  assert.equal(docx.blocks[0].type, 'heading');
  assert.equal(docx.blocks[1].type, 'bullet');
  assert.deepEqual(docx.tables[0], [['Col1', 'Col2']]);
});

function buildMultiStreamOle2(streams: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const sectorSize = 512;
  const streamMeta = streams.map((s) => ({
    name: s.name,
    data: s.data,
    sectors: Math.max(1, Math.ceil(s.data.length / sectorSize)),
  }));
  const totalDataSectors = streamMeta.reduce((sum, m) => sum + m.sectors, 0);
  const totalSectors = 2 + totalDataSectors; // sector 0 = FAT, sector 1 = Dir
  const buf = new Uint8Array((1 + totalSectors) * sectorSize);
  const dv = new DataView(buf.buffer);

  buf.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  dv.setUint16(24, 0x003e, true);
  dv.setUint16(26, 0x0003, true);
  dv.setUint16(28, 0xfffe, true);
  dv.setUint16(30, 9, true);
  dv.setUint16(32, 6, true);
  dv.setUint32(44, 1, true);
  dv.setUint32(48, 1, true);
  dv.setUint32(56, 0, true);
  dv.setUint32(60, 0xfffffffe, true);
  dv.setUint32(68, 0xfffffffe, true);
  dv.setUint32(76, 0, true);
  for (let i = 1; i < 109; i++) dv.setUint32(76 + i * 4, 0xffffffff, true);

  const fatOff = sectorSize;
  for (let i = 0; i < 128; i++) dv.setUint32(fatOff + i * 4, 0xffffffff, true);
  dv.setUint32(fatOff + 0 * 4, 0xfffffffd, true);
  dv.setUint32(fatOff + 1 * 4, 0xfffffffe, true);

  const dirOff = 2 * sectorSize;
  const writeDirName = (entryBase: number, name: string) => {
    for (let i = 0; i < name.length; i++) dv.setUint16(entryBase + i * 2, name.charCodeAt(i), true);
    dv.setUint16(entryBase + name.length * 2, 0, true);
    dv.setUint16(entryBase + 64, (name.length + 1) * 2, true);
  };
  writeDirName(dirOff, 'Root Entry');
  buf[dirOff + 66] = 5;
  dv.setUint32(dirOff + 116, 0xfffffffe, true);

  let nextSec = 2;
  for (let idx = 0; idx < streamMeta.length; idx++) {
    const m = streamMeta[idx];
    const startSec = nextSec;
    for (let s = 0; s < m.sectors; s++) {
      dv.setUint32(
        fatOff + (startSec + s) * 4,
        s + 1 < m.sectors ? startSec + s + 1 : 0xfffffffe,
        true,
      );
    }
    const eOff = dirOff + (idx + 1) * 128;
    writeDirName(eOff, m.name);
    buf[eOff + 66] = 2;
    dv.setUint32(eOff + 116, startSec, true);
    dv.setUint32(eOff + 120, m.data.length, true);
    buf.set(m.data, (1 + startSec) * sectorSize);
    nextSec += m.sectors;
  }

  return buf;
}

test('Rich presentation parsers preserve layout, frames, colors, grouped transforms, and images across PPTX, legacy PPT, and ODP', async () => {
  // 1. Rich PPTX with theme color, Slide Master decorative bar, Slide Layout placeholder xfrm, grouped shape, cropped image, and positioned table
  const zip = new JSZip();
  zip.file(
    'ppt/presentation.xml',
    `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<Relationships><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`,
  );
  zip.file(
    'ppt/theme/theme1.xml',
    `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="Test"><a:dk1><a:srgbClr val="0F172A"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="1D4ED8"/></a:accent1></a:clrScheme></a:themeElements></a:theme>`,
  );
  zip.file(
    'ppt/slideMasters/slideMaster1.xml',
    `<p:sldMaster><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="F8FAFC"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="TopBar"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="457200"/></a:xfrm><a:prstGeom prst="rect"/><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr></p:sp></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" accent1="accent1"/></p:sldMaster>`,
  );
  zip.file(
    'ppt/slideLayouts/slideLayout1.xml',
    `<p:sldLayout><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="TitlePh"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="609600" y="685800"/><a:ext cx="10972800" cy="914400"/></a:xfrm></p:spPr></p:sp></p:spTree></p:cSld></p:sldLayout>`,
  );
  zip.file(
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    `<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
  );
  zip.file(
    'ppt/slides/slide1.xml',
    `<p:sld><p:cSld><p:spTree>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:p><a:r><a:t>Inherited Position Title</a:t></a:r></a:p></p:txBody></p:sp>
      <p:grpSp>
        <p:grpSpPr><a:xfrm><a:off x="609600" y="2057400"/><a:ext cx="4876800" cy="3429000"/><a:chOff x="0" y="0"/><a:chExt cx="1000" cy="1000"/></a:xfrm></p:grpSpPr>
        <p:sp><p:nvSpPr><p:cNvPr id="3" name="Card"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000" cy="1000"/></a:xfrm><a:prstGeom prst="roundRect"/><a:solidFill><a:srgbClr val="EFF6FF"/></a:solidFill><a:ln w="19050"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:ln></p:spPr><p:txBody><a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="1600" b="1"/><a:t>Grouped Card Frame</a:t></a:r></a:p></p:txBody></p:sp>
      </p:grpSp>
      <p:pic><p:nvPicPr><p:cNvPr id="4" name="HeroImg"/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:srcRect l="10000" t="0" r="10000" b="0"/></p:blipFill><p:spPr><a:xfrm><a:off x="6096000" y="2057400"/><a:ext cx="5486400" cy="3429000"/></a:xfrm><a:prstGeom prst="roundRect"/></p:spPr></p:pic>
    </p:spTree></p:cSld></p:sld>`,
  );
  zip.file(
    'ppt/slides/_rels/slide1.xml.rels',
    `<Relationships>
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
      <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
    </Relationships>`,
  );
  zip.file('ppt/media/image1.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const pptxSlides = await parsePptxArchive(zip);
  assert.equal(pptxSlides.length, 1);
  assert.equal(pptxSlides[0].bgHex?.toLowerCase(), '#f8fafc');
  // Master bar + Title (inherited pos!) + Grouped rounded card + Cropped image = 4 z-ordered elements
  assert.equal(pptxSlides[0].elements.length, 4);
  const masterBar = pptxSlides[0].elements[0];
  assert.equal(masterBar.kind, 'shape');
  assert.equal(masterBar.fillHex?.toLowerCase(), '#1d4ed8');
  const titleEl = pptxSlides[0].elements[1];
  assert.equal(titleEl.kind, 'shape');
  assert.equal(titleEl.hasPosition, true);
  assert.ok(Math.abs(titleEl.xFrac - 0.05) < 0.005);
  const groupedCard = pptxSlides[0].elements[2];
  assert.equal(groupedCard.kind, 'shape');
  assert.equal(groupedCard.geometry, 'roundRect');
  assert.equal(groupedCard.fillHex?.toLowerCase(), '#eff6ff');
  assert.equal(groupedCard.borderHex?.toLowerCase(), '#1d4ed8');
  assert.ok(Math.abs(groupedCard.wFrac - 0.4) < 0.01);
  const heroPic = pptxSlides[0].elements[3];
  assert.equal(heroPic.kind, 'image');
  assert.equal(heroPic.geometry, 'roundRect');
  assert.ok(heroPic.crop && Math.abs(heroPic.crop.l - 0.1) < 0.001);

  // 2. Rich Legacy .ppt OLE2 binary with Escher frame + Pictures stream PNG blip + ClientAnchor coords
  const makeRec = (verInst: number, recType: number, body: Uint8Array) => {
    const out = new Uint8Array(8 + body.length);
    const dv = new DataView(out.buffer);
    dv.setUint16(0, verInst, true);
    dv.setUint16(2, recType, true);
    dv.setUint32(4, body.length, true);
    out.set(body, 8);
    return out;
  };
  const concat = (...parts: Uint8Array[]) => {
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  };

  // Pictures stream with 1 PNG blip (0xF01E: 16-byte UID + 1-byte tag + PNG signature)
  const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const blipBody = new Uint8Array(17 + fakePng.length);
  blipBody.set(fakePng, 17);
  const picturesStream = makeRec(0x6e00, 0xf01e, blipBody);

  // Escher SpContainer #1: Rounded card with fill #1E40AF, border #93C5FD, anchor (top=432, left=576, right=2880, bottom=2160)
  const sp1Fsp = new Uint8Array(8);
  new DataView(sp1Fsp.buffer).setUint32(0, 1025, true);
  const sp1Fopt = new Uint8Array(4 * 6);
  const f1dv = new DataView(sp1Fopt.buffer);
  f1dv.setUint16(0, 0x0181, true); f1dv.setUint32(2, 0x00af401e, true); // RGB(30,64,175) = #1e40af
  f1dv.setUint16(6, 0x01bf, true); f1dv.setUint32(8, 0x00100010, true); // fFilled=true
  f1dv.setUint16(12, 0x01c0, true); f1dv.setUint32(14, 0x00fdc593, true); // RGB(147,197,253) = #93c5fd
  f1dv.setUint16(18, 0x01ff, true); f1dv.setUint32(20, 0x00080008, true); // fLine=true
  const sp1Anchor = new Uint8Array(8);
  const a1dv = new DataView(sp1Anchor.buffer);
  a1dv.setInt16(0, 432, true); // top
  a1dv.setInt16(2, 576, true); // left
  a1dv.setInt16(4, 2880, true); // right
  a1dv.setInt16(6, 2160, true); // bottom
  const sp1Txt = makeRec(0x0000, 0x0fa8, new TextEncoder().encode('Escher Card Title'));
  const sp1 = makeRec(
    0x000f,
    0xf004,
    concat(
      makeRec(2 << 4, 0xf00a, sp1Fsp), // shapeType=2 (roundRect)
      makeRec((4 << 4) | 3, 0xf00b, sp1Fopt),
      makeRec(0x0000, 0xf010, sp1Anchor),
      makeRec(0x000f, 0xf00d, sp1Txt),
    ),
  );

  // Escher SpContainer #2: PictureFrame (shapeType 75) referencing pib=1
  const sp2Fopt = new Uint8Array(6);
  const f2dv = new DataView(sp2Fopt.buffer);
  f2dv.setUint16(0, 0x0104, true); f2dv.setUint32(2, 1, true); // pib = 1
  const sp2Anchor = new Uint8Array(8);
  const a2dv = new DataView(sp2Anchor.buffer);
  a2dv.setInt16(0, 432, true);
  a2dv.setInt16(2, 3168, true);
  a2dv.setInt16(4, 5184, true);
  a2dv.setInt16(6, 3456, true);
  const sp2 = makeRec(
    0x000f,
    0xf004,
    concat(
      makeRec(75 << 4, 0xf00a, sp1Fsp),
      makeRec((1 << 4) | 3, 0xf00b, sp2Fopt),
      makeRec(0x0000, 0xf010, sp2Anchor),
    ),
  );

  const spgr = makeRec(0x000f, 0xf003, concat(sp1, sp2));
  const dg = makeRec(0x000f, 0xf002, spgr);
  const drawing = makeRec(0x000f, 0x040c, dg);
  const slideRec = makeRec(0x000f, 0x03ee, drawing);

  const richPptOle = buildMultiStreamOle2([
    { name: 'PowerPoint Document', data: slideRec },
    { name: 'Pictures', data: picturesStream },
  ]);
  const legacyRichSlides = extractRichSlidesFromLegacyPpt(richPptOle);
  assert.equal(legacyRichSlides.length, 1);
  assert.equal(legacyRichSlides[0].elements.length, 2);
  const legCard = legacyRichSlides[0].elements[0];
  assert.equal(legCard.kind, 'shape');
  assert.equal(legCard.geometry, 'roundRect');
  assert.equal(legCard.fillHex?.toLowerCase(), '#1e40af');
  assert.equal(legCard.borderHex?.toLowerCase(), '#93c5fd');
  assert.ok(Math.abs(legCard.xFrac - 0.1) < 0.005);
  assert.equal(legCard.paragraphs[0].text, 'Escher Card Title');
  const legImg = legacyRichSlides[0].elements[1];
  assert.equal(legImg.kind, 'image');
  assert.equal(legImg.source.kind, 'bytes');
  assert.equal(legImg.source.mime, 'image/png');
  assert.ok(Math.abs(legImg.xFrac - 0.55) < 0.005);

  // 3. Rich ODP preserving real svg:x/y/width/height + styles.xml page dimensions + fills
  const odpRich = parseRichOdpXml(
    `<office:document-content><office:automatic-styles><style:style style:name="gr1"><style:graphic-properties draw:fill-color="#DBEAFE" svg:stroke-color="#1D4ED8"/></style:style></office:automatic-styles><office:body><office:presentation><draw:page><draw:custom-shape draw:style-name="gr1" svg:x="2.8cm" svg:y="2.1cm" svg:width="14cm" svg:height="8.4cm"><text:p>Positioned ODP Box</text:p></draw:custom-shape><draw:frame svg:x="17.5cm" svg:y="2.1cm" svg:width="8.4cm" svg:height="8.4cm"><draw:image xlink:href="Pictures/pic1.png"/></draw:frame></draw:page></office:presentation></office:body></office:document-content>`,
    `<office:document-styles><office:automatic-styles><style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="21cm"/></style:page-layout></office:automatic-styles></office:document-styles>`,
  );
  assert.equal(odpRich.length, 1);
  assert.equal(odpRich[0].elements.length, 2);
  const odpBox = odpRich[0].elements[0];
  assert.equal(odpBox.kind, 'shape');
  assert.equal(odpBox.hasPosition, true);
  assert.ok(Math.abs(odpBox.xFrac - 0.1) < 0.005);
  assert.equal(odpBox.fillHex?.toLowerCase(), '#dbeafe');
  const odpImg = odpRich[0].elements[1];
  assert.equal(odpImg.kind, 'image');
  assert.equal(odpImg.hasPosition, true);
  assert.ok(Math.abs(odpImg.xFrac - 0.625) < 0.005);
});

