import { TOOL_BY_ID } from '../data/toolsCatalog';
import type {
  DeviceProfile,
  PreflightAssessment,
  PreflightIssue,
  PreflightSeverity,
  ToolId,
} from '../types/tools';
import { formatBytes } from './pdfUtils';

const MB = 1024 * 1024;
const GB = 1024 * MB;

/**
 * Reads available browser hardware signals to estimate a safe single-tab RAM budget.
 * Never enforces a hard block; used solely to surface honest device-specific risk signs.
 */
export function detectDeviceProfile(): DeviceProfile {
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }) : undefined;
  const perf =
    typeof performance !== 'undefined'
      ? (performance as Performance & { memory?: { jsHeapSizeLimit?: number } })
      : undefined;

  const ua = nav?.userAgent ?? '';
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const hardwareConcurrency = nav?.hardwareConcurrency ?? 4;
  const deviceMemoryGb = typeof nav?.deviceMemory === 'number' ? nav.deviceMemory : null;
  const jsHeapLimitBytes =
    typeof perf?.memory?.jsHeapSizeLimit === 'number' ? perf.memory.jsHeapSizeLimit : null;

  return buildDeviceProfile({
    deviceMemoryGb,
    hardwareConcurrency,
    isMobile,
    jsHeapLimitBytes,
  });
}

export function buildDeviceProfile(params: {
  deviceMemoryGb: number | null;
  hardwareConcurrency: number;
  isMobile: boolean;
  jsHeapLimitBytes: number | null;
}): DeviceProfile {
  const { deviceMemoryGb, hardwareConcurrency, isMobile, jsHeapLimitBytes } = params;

  // Estimate safe peak working memory for browser JS/WASM/Canvas allocations.
  // Browsers typically crash a single renderer tab well below total system RAM.
  let estimatedSafeBudgetBytes: number;
  if (deviceMemoryGb !== null) {
    if (isMobile) {
      // Mobile Safari / Chrome kill tabs aggressively (~250MB - 600MB)
      estimatedSafeBudgetBytes = Math.min(deviceMemoryGb * 0.14 * GB, 650 * MB);
    } else if (deviceMemoryGb <= 4) {
      estimatedSafeBudgetBytes = 700 * MB;
    } else if (deviceMemoryGb <= 8) {
      estimatedSafeBudgetBytes = 1.4 * GB;
    } else {
      estimatedSafeBudgetBytes = 2.2 * GB;
    }
  } else {
    // Firefox/Safari don't expose navigator.deviceMemory; infer conservatively from mobile/cores
    if (isMobile) {
      estimatedSafeBudgetBytes = 420 * MB;
    } else if (hardwareConcurrency <= 4) {
      estimatedSafeBudgetBytes = 900 * MB;
    } else {
      estimatedSafeBudgetBytes = 1.5 * GB;
    }
  }

  if (jsHeapLimitBytes !== null && jsHeapLimitBytes > 0) {
    // Stay below ~60% of reported JS heap ceiling (ArrayBuffers + canvas count alongside heap)
    estimatedSafeBudgetBytes = Math.min(estimatedSafeBudgetBytes, jsHeapLimitBytes * 0.65);
  }

  return {
    deviceMemoryGb,
    hardwareConcurrency,
    isMobile,
    jsHeapLimitBytes,
    estimatedSafeBudgetBytes: Math.max(200 * MB, Math.round(estimatedSafeBudgetBytes)),
  };
}

export interface FileHeaderProbe {
  fileName: string;
  sizeBytes: number;
  detectedType: 'pdf' | 'png' | 'jpeg' | 'webp' | 'zip-or-docx' | 'text' | 'empty' | 'unknown';
  isEncryptedPdf: boolean;
  hasValidPdfHeader: boolean;
}

/**
 * Inspects a small head + tail byte slice (e.g. first 64KB + last 64KB) so inspecting
 * even a 2 GB file takes <2ms and consumes virtually zero RAM.
 */
export function inspectFileHeaderBytes(
  headBytes: Uint8Array,
  tailBytes: Uint8Array | null,
  fileName: string,
  totalSizeBytes: number,
): FileHeaderProbe {
  if (totalSizeBytes === 0 || headBytes.length === 0) {
    return {
      fileName,
      sizeBytes: totalSizeBytes,
      detectedType: 'empty',
      isEncryptedPdf: false,
      hasValidPdfHeader: false,
    };
  }

  // Check PDF magic header "%PDF-" within first 1024 bytes (PDF spec allows leading junk bytes)
  const asciiHead = decodeLatin1(headBytes.subarray(0, Math.min(headBytes.length, 4096)));
  const pdfIdx = asciiHead.indexOf('%PDF-');
  if (pdfIdx !== -1 && pdfIdx < 1024) {
    const tailText = tailBytes ? decodeLatin1(tailBytes) : '';
    const fullHeadText = decodeLatin1(headBytes);
    const isEncryptedPdf =
      /\/Encrypt\b/.test(tailText) || /\/Encrypt\b/.test(fullHeadText);
    return {
      fileName,
      sizeBytes: totalSizeBytes,
      detectedType: 'pdf',
      isEncryptedPdf,
      hasValidPdfHeader: true,
    };
  }

  // PNG: 89 50 4E 47
  if (
    headBytes.length >= 4 &&
    headBytes[0] === 0x89 &&
    headBytes[1] === 0x50 &&
    headBytes[2] === 0x4e &&
    headBytes[3] === 0x47
  ) {
    return {
      fileName,
      sizeBytes: totalSizeBytes,
      detectedType: 'png',
      isEncryptedPdf: false,
      hasValidPdfHeader: false,
    };
  }

  // JPEG: FF D8 FF
  if (headBytes.length >= 3 && headBytes[0] === 0xff && headBytes[1] === 0xd8 && headBytes[2] === 0xff) {
    return {
      fileName,
      sizeBytes: totalSizeBytes,
      detectedType: 'jpeg',
      isEncryptedPdf: false,
      hasValidPdfHeader: false,
    };
  }

  // WebP: RIFF....WEBP
  if (
    headBytes.length >= 12 &&
    asciiHead.startsWith('RIFF') &&
    asciiHead.slice(8, 12) === 'WEBP'
  ) {
    return {
      fileName,
      sizeBytes: totalSizeBytes,
      detectedType: 'webp',
      isEncryptedPdf: false,
      hasValidPdfHeader: false,
    };
  }

  // ZIP / DOCX: PK\x03\x04
  if (
    headBytes.length >= 4 &&
    headBytes[0] === 0x50 &&
    headBytes[1] === 0x4b &&
    headBytes[2] === 0x03 &&
    headBytes[3] === 0x04
  ) {
    return {
      fileName,
      sizeBytes: totalSizeBytes,
      detectedType: 'zip-or-docx',
      isEncryptedPdf: false,
      hasValidPdfHeader: false,
    };
  }

  // Printable text heuristic (HTML, Markdown, CSV, TXT)
  const sampleLen = Math.min(headBytes.length, 512);
  let nonTextCount = 0;
  for (let i = 0; i < sampleLen; i++) {
    const b = headBytes[i];
    if (b === 0) {
      nonTextCount += 10;
      break;
    }
    if (b < 9 || (b > 13 && b < 32)) {
      nonTextCount++;
    }
  }
  const detectedType = nonTextCount / sampleLen < 0.08 ? 'text' : 'unknown';

  return {
    fileName,
    sizeBytes: totalSizeBytes,
    detectedType,
    isEncryptedPdf: false,
    hasValidPdfHeader: false,
  };
}

function decodeLatin1(bytes: Uint8Array): string {
  let out = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    out += String.fromCharCode(...sub);
  }
  return out;
}

/**
 * Reads only the first 64 KB and last 64 KB of a browser File object for fast preflight probing.
 */
export async function probeBrowserFile(file: File): Promise<FileHeaderProbe> {
  const SLICE = 64 * 1024;
  const headBuf = await file.slice(0, Math.min(file.size, SLICE)).arrayBuffer();
  const tailBuf =
    file.size > SLICE
      ? await file.slice(Math.max(0, file.size - SLICE), file.size).arrayBuffer()
      : null;

  return inspectFileHeaderBytes(
    new Uint8Array(headBuf),
    tailBuf ? new Uint8Array(tailBuf) : null,
    file.name,
    file.size,
  );
}

/**
 * Pure deterministic evaluator combining file header probes, tool memory multiplier,
 * cumulative parallel-tab load, and device hardware capability.
 * Always produces an advisory risk sign—never imposes a hard file size cap.
 */
export function assessWorkloadRisk(input: {
  probes: FileHeaderProbe[];
  toolId: ToolId;
  otherTabsBytes: number;
  device: DeviceProfile;
  extraMultiplier?: number;
}): PreflightAssessment {
  const { probes, toolId, otherTabsBytes, device, extraMultiplier = 1 } = input;
  const tool = TOOL_BY_ID[toolId];
  const issues: PreflightIssue[] = [];
  const tips: string[] = [];

  let totalInputBytes = 0;
  for (const probe of probes) {
    totalInputBytes += probe.sizeBytes;

    if (probe.detectedType === 'empty') {
      issues.push({
        id: `empty-${probe.fileName}`,
        severity: 'unprocessable',
        fileName: probe.fileName,
        title: 'Empty file (0 bytes)',
        detail: `"${probe.fileName}" contains no data and cannot be parsed.`,
        actionHint: 'Verify the file finished downloading on your device.',
      });
      continue;
    }

    if (tool.expectedKind === 'pdf') {
      if (!probe.hasValidPdfHeader) {
        issues.push({
          id: `invalid-pdf-${probe.fileName}`,
          severity: 'unprocessable',
          fileName: probe.fileName,
          title: 'Unrecognized or corrupted PDF header',
          detail: `"${probe.fileName}" does not start with a valid %PDF header (detected: ${probe.detectedType}). Processing will likely fail.`,
          actionHint: 'Check whether the file was renamed from another format or truncated.',
        });
      } else if (probe.isEncryptedPdf && toolId !== 'unlock') {
        issues.push({
          id: `encrypted-${probe.fileName}`,
          severity: 'caution',
          fileName: probe.fileName,
          title: 'Password-protected PDF detected',
          detail: `"${probe.fileName}" contains PDF encryption metadata. This tool may not be able to read or save it while locked.`,
          actionHint: 'Open it in "Unlock PDF" first if you know the password.',
        });
      }
    } else if (tool.expectedKind === 'image') {
      if (!['png', 'jpeg', 'webp'].includes(probe.detectedType)) {
        issues.push({
          id: `invalid-img-${probe.fileName}`,
          severity: 'unprocessable',
          fileName: probe.fileName,
          title: 'Unsupported image format',
          detail: `"${probe.fileName}" does not appear to be a PNG, JPEG, or WebP image (detected: ${probe.detectedType}).`,
          actionHint: 'Use PNG, JPEG, or WebP files for reliable client-side embedding.',
        });
      }
    } else if (tool.expectedKind === 'converter') {
      const ext = probe.fileName.toLowerCase().split('.').pop() ?? '';
      if (['doc', 'ppt', 'pptx', 'xls', 'xlsx'].includes(ext)) {
        issues.push({
          id: `office-limit-${probe.fileName}`,
          severity: 'caution',
          fileName: probe.fileName,
          title: 'Legacy or complex Office format',
          detail: `".${ext}" files cannot be faithfully converted in pure client-side JavaScript without a server engine.`,
          actionHint: 'Export to PDF, CSV, HTML, Markdown, or .docx first for best results.',
        });
      }
    }
  }

  // Estimate peak RAM usage:
  // current files * tool multiplier * extraMultiplier (e.g. high DPI) + baseline overhead of other open tabs
  const effectiveMultiplier = tool.memoryMultiplier * extraMultiplier;
  const currentWorkPeak = totalInputBytes * effectiveMultiplier;
  const otherTabsOverhead = otherTabsBytes * 1.6;
  const estimatedPeakBytes = Math.round(currentWorkPeak + otherTabsOverhead);
  const ratio = device.estimatedSafeBudgetBytes > 0 ? estimatedPeakBytes / device.estimatedSafeBudgetBytes : 0;

  // Browser ArrayBuffer hard ceiling warning (>1.8GB single file often exceeds V8/WebKit ArrayBuffer allocation)
  const hasHugeSingleFile = probes.some((p) => p.sizeBytes >= 1.5 * GB);

  if (hasHugeSingleFile || ratio >= 0.85) {
    issues.push({
      id: 'device-crash-risk',
      severity: 'high-risk',
      title: 'High browser crash risk on this device',
      detail: `Estimated peak memory (${formatBytes(estimatedPeakBytes)}) approaches or exceeds this device's safe browser tab budget (${formatBytes(device.estimatedSafeBudgetBytes)}). No upload limit is enforced, so you may still try—but the tab could freeze or crash out of memory.`,
      actionHint:
        otherTabsBytes > 20 * MB
          ? 'Close other heavy workspace tabs or split the document into smaller batches first.'
          : 'Lower output DPI/quality if available, or process on a desktop with more RAM.',
    });
    if (otherTabsBytes > 20 * MB) {
      tips.push(`Other open tabs are currently holding ${formatBytes(otherTabsBytes)} in memory.`);
    }
    if (tool.memoryMultiplier >= 6) {
      tips.push(`${tool.name} renders full pages to bitmaps, which uses ~${tool.memoryMultiplier.toFixed(1)}× the raw file size in RAM.`);
    }
    if (device.isMobile) {
      tips.push('Mobile browsers enforce stricter per-tab memory caps than desktop browsers.');
    }
  } else if (ratio >= 0.45) {
    issues.push({
      id: 'device-slowdown-caution',
      severity: 'caution',
      title: 'Heavy workload for this device — processing may be slow',
      detail: `Estimated peak memory is ${formatBytes(estimatedPeakBytes)} against ~${formatBytes(device.estimatedSafeBudgetBytes)} safe tab headroom. Processing remains unrestricted and will run locally.`,
      actionHint: 'Avoid running multiple raster/OCR jobs at the exact same time.',
    });
    if (otherTabsBytes > 20 * MB) {
      tips.push(`Other open tabs currently hold ${formatBytes(otherTabsBytes)}.`);
    }
  }

  let level: PreflightSeverity = 'ok';
  if (issues.some((i) => i.severity === 'unprocessable')) {
    level = 'unprocessable';
  } else if (issues.some((i) => i.severity === 'high-risk')) {
    level = 'high-risk';
  } else if (issues.some((i) => i.severity === 'caution')) {
    level = 'caution';
  }

  const ramLabel =
    device.deviceMemoryGb !== null
      ? `~${device.deviceMemoryGb} GB RAM`
      : `${device.hardwareConcurrency} CPU threads`;
  const classLabel = device.isMobile ? 'Mobile browser' : 'Desktop browser';
  const deviceSummary = `${classLabel} · ${ramLabel} · Safe tab budget ~${formatBytes(device.estimatedSafeBudgetBytes)}`;

  return {
    level,
    issues,
    estimatedPeakBytes,
    deviceBudgetBytes: device.estimatedSafeBudgetBytes,
    totalInputBytes,
    otherTabsBytes,
    deviceSummary,
    tips,
  };
}
