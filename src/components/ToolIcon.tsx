import {
  Combine,
  Scissors,
  Minimize2,
  PenLine,
  Signature,
  RefreshCw,
  ImagePlus,
  Images,
  ImageDown,
  Lock,
  Unlock,
  RotateCw,
  Trash2,
  FileOutput,
  ArrowUpDown,
  Globe,
  ScanText,
  Stamp,
  Hash,
  Layers,
  GitCompareArrows,
  Zap,
  Eraser,
  FilePlus2,
  Crop,
} from 'lucide-react';
import type { ToolId } from '../types/tools';

interface ToolIconProps {
  toolId: ToolId;
  className?: string;
}

export function ToolIcon({ toolId, className = 'w-5 h-5' }: ToolIconProps) {
  switch (toolId) {
    case 'merge':
      return <Combine className={className} />;
    case 'split':
      return <Scissors className={className} />;
    case 'compress':
      return <Minimize2 className={className} />;
    case 'edit':
      return <PenLine className={className} />;
    case 'sign':
      return <Signature className={className} />;
    case 'converter':
      return <RefreshCw className={className} />;
    case 'images-to-pdf':
      return <ImagePlus className={className} />;
    case 'pdf-to-images':
      return <Images className={className} />;
    case 'extract-images':
      return <ImageDown className={className} />;
    case 'protect':
      return <Lock className={className} />;
    case 'unlock':
      return <Unlock className={className} />;
    case 'rotate':
      return <RotateCw className={className} />;
    case 'remove-pages':
      return <Trash2 className={className} />;
    case 'extract-pages':
      return <FileOutput className={className} />;
    case 'rearrange':
      return <ArrowUpDown className={className} />;
    case 'webpage-to-pdf':
      return <Globe className={className} />;
    case 'ocr':
      return <ScanText className={className} />;
    case 'watermark':
      return <Stamp className={className} />;
    case 'page-numbers':
      return <Hash className={className} />;
    case 'overlay':
      return <Layers className={className} />;
    case 'compare':
      return <GitCompareArrows className={className} />;
    case 'web-optimize':
      return <Zap className={className} />;
    case 'redact':
      return <Eraser className={className} />;
    case 'create-pdf':
      return <FilePlus2 className={className} />;
    case 'crop':
      return <Crop className={className} />;
    default:
      return <FilePlus2 className={className} />;
  }
}
