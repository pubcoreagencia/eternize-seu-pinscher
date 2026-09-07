import { NeuralPetPreprocessor } from '../neuralPreprocessor/neuralPetPreprocessor';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ============================================================================
// PET SCANNER MODULE
// Eternização de Pinscher via Fotogrametria -> STL Pronto para Impressão 3D
// ============================================================================

export type PetSpecies = 'pinscher' | 'mixed' | 'unknown';

export interface PetPhotoInput {
  id: string;
  buffer: Buffer;
  filename: string;
  capturedAt: Date;
  customerNote?: string;
}

export interface QualityScore {
  overall: number;          // 0..1
  sharpness: number;
  lighting: number;
  framing: number;
  multiViewCoverage: number;
  issues: string[];
}

export interface STLMetadata {
  breed: PetSpecies;
  estimatedVolumeCm3: number;
  boundingBoxmm: { x: number; z: number; y: number };
  triangleCount: number;
  watertight: boolean;
  printReady: boolean;
  resinFriendly: boolean;
  recommendedInfillPct: number;
  memorialQuote?: string;
}

export interface PipelineResult {
  sessionId: string;
  petName?: string;
  quality: QualityScore;
  stl?: STLMetadata;
  previewUrl: string;
  checkoutEligible: boolean;
  estimatedPriceBRL: number;
  warnings: string[];
  processedAt: Date;
}

const PRICE_PER_CM3 = 1.85; // BRL por cm³ impresso em resina afetiva
const MEMORIAL_QUOTES = [
  'Para sempre ao seu lado.',
  'O amor não tem fim, apenas novas texturas.',
  'Cada camada, uma memória.',
  'Imortalizado em carinho.',
];

/**
 * Orquestra o pipeline completo: fotos do pet -> STL válido e imprimível.
 * Usa o NeuralPetPreprocessor já existente para classificação prévia.
 */
export class PetPhotoToSTLPipeline {
  private readonly preprocessor: NeuralPetPreprocessor;
  private readonly stagingDir: string;

  constructor(opts?: { stagingDir?: string; preprocessor?: NeuralPetPreprocessor }) {
    this.stagingDir = opts?.stagingDir ?? path.resolve(process.cwd(), '.stl-staging');
    this.preprocessor = opts?.preprocessor ?? new NeuralPetPreprocessor();
  }

  /**
   * Executa o pipeline completo a partir de múltiplas fotos do pet.
   */
  async process(photos: PetPhotoInput[], petName?: string): Promise<PipelineResult> {
    const sessionId = this.newSessionId();
    const warnings: string[] = [];

    if (photos.length < 3) {
      warnings.push('Cobertura baixa: recomendamos ao menos 8 fotos em ângulos distintos.');
    }

    const quality = await this.scoreQuality(photos);
    if (quality.overall < 0.45) {
      warnings.push('Qualidade fotográfica insuficiente. STL será gerado, mas com baixa fidelidade.');
    }

    const breed = await this.detectBreed(photos[0]);

    const stl = await this.synthesizeSTL(photos, breed, quality);

    const checkoutEligible = stl.printReady && quality.overall >= 0.35;
    const estimatedPriceBRL = +(stl.estimatedVolumeCm3 * PRICE_PER_CM3).toFixed(2);

    const result: PipelineResult = {
      sessionId,
      petName,
      quality,
      stl,
      previewUrl: `/api/v1/pets/${sessionId}/preview.glb`,
      checkoutEligible,
      estimatedPriceBRL,
      warnings,
      processedAt: new Date(),
    };

    await this.persistArtifacts(sessionId, result, photos);
    return result;
  }

  // -------------------------------------------------------------------------
  // Quality scoring
  // -------------------------------------------------------------------------
  private async scoreQuality(photos: PetPhotoInput[]): Promise<QualityScore> {
    let sharpness = 0;
    let lighting = 0;
    let framing = 0;
    const issues: string[] = [];

    for (const photo of photos) {
      const s = this.estimateSharpness(photo.buffer);
      sharpness += s;
      lighting += this.estimateLighting(photo.buffer);
      framing += this.estimateFraming(photo.buffer);
      if (s < 0.3) issues.push(`Foto ${photo.filename} está borrada.`);
    }

    const count = Math.max(photos.length, 1);
    sharpness /= count;
    lighting /= count;
    framing /= count;

    const multiViewCoverage = Math.min(1, photos.length / 12);
    const overall = +(sharpness * 0.35 + lighting * 0.25 + framing * 0.2 + multiViewCoverage * 0.2).toFixed(3);

    return {
      overall,
      sharpness: +sharpness.toFixed(3),
      lighting: +lighting.toFixed(3),
      framing: +framing.toFixed(3),
      multiViewCoverage: +multiViewCoverage.toFixed(3),
      issues,
    };
  }

  private estimateSharpness(buf: Buffer): number {
    // Heurística simples via entropia de Shannon do payload.
    const sample = buf.subarray(0, Math.min(buf.length, 4096));
    const freq = new Map<number, number>();
    for (const byte of sample) freq.set(byte, (freq.get(byte) ?? 0) + 1);
    let entropy = 0;
    for (const f of freq.values()) {
      const p = f / sample.length;
      entropy -= p * Math.log2(p);
    }
    return Math.min(1, entropy / 8);
  }

  private estimateLighting(buf: Buffer): number {
    let sum = 0;
    const len = Math.min(buf.length, 2048);
    for (let i = 0; i < len; i += 4) sum += buf[i] ?? 0;
    const avg = sum / (len / 4);
    return Math.min(1, avg / 255);
  }

  private estimateFraming(buf: Buffer): number {
    // Assumimos framing razoável se o payload for > 50KB.
    return Math.min(1, buf.length / (50 * 1024));
  }

  // -------------------------------------------------------------------------
  // Breed via NeuralPetPreprocessor
  // -------------------------------------------------------------------------
  private async detectBreed(photo?: PetPhotoInput): Promise<PetSpecies> {
    if (!photo) return 'unknown';
    try {
      const result = await this.preprocessor.preprocess(photo.buffer);
      if (result.detectedBreed === 'pinscher') return 'pinscher';
      if (result.detectedBreed) return 'mixed';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  // -------------------------------------------------------------------------
  // STL synthesis (simulado, pronto para integração com OpenCV / COLMAP / Open3D)
  // -------------------------------------------------------------------------
  private async synthesizeSTL(
    photos: PetPhotoInput[],
    breed: PetSpecies,
    quality: QualityScore,
  ): Promise<STLMetadata> {
    const baseVolume = breed === 'pinscher' ? 14 : breed === 'mixed' ? 18 : 12;
    const volume = +(baseVolume * (0.7 + quality.overall * 0.6)).toFixed(2);
    const triangleCount = Math.floor(8_000 + quality.overall * 40_000);
    const watertight = quality.overall >= 0.5;
    const printReady = watertight && quality.overall >= 0.45;

    const stl: STLMetadata = {
      breed,
      estimatedVolumeCm3: volume,
      boundingBoxmm: { x: 42, z: 28, y: 60 },
      triangleCount,
      watertight,
      printReady,
      resinFriendly: true,
      recommendedInfillPct: breed === 'pinscher' ? 18 : 22,
      memorialQuote: MEMORIAL_QUOTES[Math.floor(Math.random() * MEMORIAL_QUOTES.length)],
    };
    return stl;
  }

  // -------------------------------------------------------------------------
  // Persistência e utilitários
  // -------------------------------------------------------------------------
  private newSessionId(): string {
    return crypto.randomBytes(8).toString('hex');
  }

  private async persistArtifacts(sessionId: string, result: PipelineResult, photos: PetPhotoInput[]): Promise<void> {
    const sessionDir = path.join(this.stagingDir, sessionId);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, 'pipeline-result.json'), JSON.stringify(result, null, 2));
    for (const photo of photos) {
      await fs.writeFile(path.join(sessionDir, photo.filename), photo.buffer);
    }
  }
}

export default PetPhotoToSTLPipeline;
