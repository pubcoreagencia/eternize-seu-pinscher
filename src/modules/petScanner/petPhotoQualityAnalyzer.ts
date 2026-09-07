import * as crypto from 'crypto';
import { PhotoQualityResult, PhotoQualityThresholds } from './petPhotoQuality.types';

const DEFAULT_THRESHOLDS: PhotoQualityThresholds = {
  minResolution: 1024,
  minBlurScore: 0.45,
  minLightingScore: 0.40,
  minFramingScore: 0.50,
  minFaceVisibilityScore: 0.60,
  acceptedFormats: ['image/jpeg', 'image/png', 'image/heic', 'image/webp'],
  maxFileSizeMb: 20,
};

const ANIMAL_KEYWORDS = ['dog', 'puppy', 'cat', 'pet', 'pinscher', 'yorkshire', 'poodle', 'bulldog', 'retriever', 'canino', 'gato', 'cachorro'];
const FACE_CASCADE_HINTS = ['face', 'snout', 'eye', 'ear', 'muzzle', 'rosto', 'focinho', 'olho', 'orelha'];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sha256(buffer: Buffer | string): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function estimateBlur(buffer: Buffer, width: number, height: number): number {
  const sampleSize = Math.min(buffer.length, 4096);
  let varianceSum = 0;
  for (let i = 1; i < sampleSize; i++) {
    const diff = buffer[i] - buffer[i - 1];
    varianceSum += diff * diff;
  }
  const variance = varianceSum / sampleSize;
  const normalized = clamp(variance / (255 * 255), 0, 1);
  const pixelFactor = clamp((width * height) / (4096 * 4096), 0, 1);
  return clamp(normalized * 0.6 + pixelFactor * 0.4, 0, 1);
}

function estimateLighting(buffer: Buffer): number {
  let histogram = new Array(8).fill(0);
  for (let i = 0; i < Math.min(buffer.length, 8192); i++) {
    const bin = Math.floor((buffer[i] / 256) * 8);
    histogram[Math.min(bin, 7)] += 1;
  }
  const total = histogram.reduce((a, b) => a + b, 0) || 1;
  const middle = histogram.slice(2, 6).reduce((a, b) => a + b, 0) / total;
  return clamp(middle * 1.4, 0, 1);
}

function detectAnimalCues(metadata: Record<string, unknown>): number {
  const corpus = JSON.stringify(metadata).toLowerCase();
  let hits = 0;
  for (const kw of ANIMAL_KEYWORDS) {
    if (corpus.includes(kw)) hits += 1;
  }
  return clamp(hits / 4, 0, 1);
}

function detectFaceCues(metadata: Record<string, unknown>): number {
  const corpus = JSON.stringify(metadata).toLowerCase();
  let hits = 0;
  for (const kw of FACE_CASCADE_HINTS) {
    if (corpus.includes(kw)) hits += 1;
  }
  return clamp(hits / 3, 0, 1);
}

function estimateFraming(width: number, height: number): number {
  if (!width || !height) return 0;
  const ratio = width / height;
  const idealCenter = 0.75;
  const idealEdge = 1.5;
  if (ratio >= idealCenter && ratio <= idealEdge) return 1;
  const distance = ratio < idealCenter ? idealCenter - ratio : ratio - idealEdge;
  return clamp(1 - distance, 0, 1);
}

export interface AnalyzePhotoInput {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  fileSizeBytes: number;
  width: number;
  height: number;
  exif?: Record<string, unknown>;
  aiTags?: Record<string, unknown>;
  thresholds?: Partial<PhotoQualityThresholds>;
}

export class PetPhotoQualityAnalyzer {
  private thresholds: PhotoQualityThresholds;

  constructor(thresholds: Partial<PhotoQualityThresholds> = {}) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  public analyze(input: AnalyzePhotoInput): PhotoQualityResult {
    const startedAt = Date.now();
    const reasons: string[] = [];
    const suggestions: string[] = [];
    const checks: PhotoQualityResult['checks'] = {};

    if (!this.thresholds.acceptedFormats.includes(input.mimeType)) {
      reasons.push(`Formato ${input.mimeType} não suportado.`);
      suggestions.push('Envie a foto em JPG, PNG, HEIC ou WEBP.');
    }

    const sizeMb = input.fileSizeBytes / (1024 * 1024);
    checks.fileSize = sizeMb <= this.thresholds.maxFileSizeMb;
    if (!checks.fileSize) {
      reasons.push(`Arquivo de ${sizeMb.toFixed(2)}MB excede o limite de ${this.thresholds.maxFileSizeMb}MB.`);
      suggestions.push('Comprima a imagem antes do upload.');
    }

    checks.resolution = input.width >= this.thresholds.minResolution && input.height >= this.thresholds.minResolution;
    if (!checks.resolution) {
      reasons.push(`Resolução ${input.width}x${input.height} abaixo de ${this.thresholds.minResolution}px.`);
      suggestions.push('Use uma foto com pelo menos 1024px no menor lado.');
    }

    const blur = estimateBlur(input.buffer, input.width, input.height);
    checks.blur = blur >= this.thresholds.minBlurScore;
    if (!checks.blur) {
      reasons.push('Foto parece borrada.');
      suggestions.push('Estabilize a câmera e tire em ambiente iluminado.');
    }

    const lighting = estimateLighting(input.buffer);
    checks.lighting = lighting >= this.thresholds.minLightingScore;
    if (!checks.lighting) {
      reasons.push('Iluminação inadequada (muito escura ou estourada).');
      suggestions.push('Posicione o pet próximo a uma janela com luz difusa.');
    }

    const framing = estimateFraming(input.width, input.height);
    checks.framing = framing >= this.thresholds.minFramingScore;
    if (!checks.framing) {
      reasons.push('Enquadramento do pet não centralizado.');
      suggestions.push('Centralize o focinho do pet no quadro.');
    }

    const metadata = { ...(input.exif ?? {}), ...(input.aiTags ?? {}) };
    const animalCue = detectAnimalCues(metadata);
    const faceCue = detectFaceCues(metadata);
    const faceVisibility = clamp(animalCue * 0.5 + faceCue * 0.5, 0, 1);
    checks.faceVisibility = faceVisibility >= this.thresholds.minFaceVisibilityScore;
    if (!checks.faceVisibility) {
      reasons.push('Focinho/olhos do pet pouco visíveis ou detectados.');
      suggestions.push('Tire uma foto frontal, com olhos e focinho aparentes.');
    }

    const scores: PhotoQualityResult['scores'] = {
      blur,
      lighting,
      framing,
      faceVisibility,
      resolutionRatio: clamp((input.width * input.height) / (2048 * 2048), 0, 1),
    };

    const overallScore = clamp(
      scores.blur * 0.25 + scores.lighting * 0.20 + scores.framing * 0.20 +
      scores.faceVisibility * 0.25 + scores.resolutionRatio * 0.10,
      0, 1,
    );

    const allPassed = Object.values(checks).every(Boolean);
    const readyForStl = allPassed && overallScore >= 0.65;

    return {
      readyForStl,
      overallScore,
      scores,
      checks,
      reasons,
      suggestions,
      fingerprint: sha256(input.buffer).slice(0, 16),
      fileName: input.fileName,
      mimeType: input.mimeType,
      width: input.width,
      height: input.height,
      fileSizeBytes: input.fileSizeBytes,
      processedAt: new Date().toISOString(),
      processingMs: Date.now() - startedAt,
    };
  }

  public async analyzeFromFile(input: AnalyzePhotoInput): Promise<PhotoQualityResult> {
    return Promise.resolve(this.analyze(input));
  }
}

export const defaultPhotoQualityAnalyzer = new PetPhotoQualityAnalyzer();
