import { PetScanInput, PetPhotoMetadata } from './petPhotoQualityAnalyzer';

/**
 * Tipos de medidas estimadas a partir de fotos 2D do pet.
 * Utilizado para projetar o volume de impressão 3D.
 */
export interface DimensionalEstimate {
  lengthCm: number;          // focinho até base da cauda
  heightCm: number;          // chão até topo da cabeça/costelas
  widthCm: number;           // largura torácica
  weightEstimateKg: number;  // estimativa de massa via fórmula alométrica
  volumeCm3: number;         // volume aproximado para cálculo de filamento
  confidence: number;        // 0..1
  boundingBox: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  };
  scaleFactor: number;       // fator de escala aplicado ao STL final
  breedClass: BreedClass;
  notes: string[];
}

export type BreedClass =
  | 'pinscher-miniatura'
  | 'pinscher-alemao'
  | 'dobermann'
  | 'outro-canino'
  | 'gato'
  | 'desconhecido';

interface ReferenceObject {
  type: 'credit-card' | 'coin' | 'ruler' | 'hand' | 'unknown';
  realSizeCm: number;       // dimensão real conhecida do objeto referência
  pixelSize: number;        // tamanho em pixels na imagem
}

interface AlometricCoefficients {
  // Coeficientes da fórmula Massa = a * L^b (L em cm)
  a: number;
  b: number;
}

const ALOMETRY: Record<BreedClass, AlometricCoefficients> = {
  'pinscher-miniatura': { a: 0.0042, b: 2.85 },
  'pinscher-alemao':    { a: 0.0058, b: 2.83 },
  'dobermann':          { a: 0.0069, b: 2.81 },
  'outro-canino':       { a: 0.0056, b: 2.84 },
  'gato':               { a: 0.0039, b: 2.92 },
  'desconhecido':       { a: 0.0050, b: 2.85 },
};

/**
 * Detecta a classe provável da raça a partir de metadata e proporção w/h.
 */
export function inferBreedClass(meta: PetPhotoMetadata): BreedClass {
  if (meta.species === 'cat') return 'gato';
  if (meta.species !== 'dog') return 'desconhecido';

  const ar = meta.aspectRatio; // largura/altura do bounding box
  // Pinschers tendem a ser mais longilíneos (ar > 0.55) e baixos.
  if (meta.estimatedWeightKg !== undefined && meta.estimatedWeightKg < 5) {
    return 'pinscher-miniatura';
  }
  if (meta.estimatedWeightKg !== undefined && meta.estimatedWeightKg >= 5 && meta.estimatedWeightKg < 12 && ar > 0.5) {
    return 'pinscher-alemao';
  }
  if (meta.estimatedWeightKg !== undefined && meta.estimatedWeightKg >= 25 && ar > 0.6) {
    return 'dobermann';
  }
  return 'outro-canino';
}

/**
 * Calcula a razão pixels/centímetro a partir de um objeto de referência.
 */
export function pixelsPerCm(ref: ReferenceObject | undefined): number {
  if (!ref || ref.type === 'unknown' || ref.pixelSize <= 0) {
    return 12; // fallback heurístico: ~12 px/cm para fotos típicas de pet
  }
  return ref.pixelSize / ref.realSizeCm;
}

/**
 * Estima as dimensões físicas do pet em centímetros a partir de múltiplas vistas.
 */
export function estimateDimensions(
  input: PetScanInput,
  options?: {
    referenceObject?: ReferenceObject;
    overrideBreed?: BreedClass;
  }
): DimensionalEstimate {
  const meta = input.metadata;
  const breed = options?.overrideBreed ?? inferBreedClass(meta);
  const ppc = pixelsPerCm(options?.referenceObject);

  // Conversão pixel -> cm das dimensões do bounding box frontal.
  const lengthCm = +(meta.boundingBox.widthPx / ppc).toFixed(2);
  const heightCm = +(meta.boundingBox.heightPx / ppc).toFixed(2);

  // Estimativa de largura torácica: ~40% da altura para cães longilíneos,
  // ~55% para gatos (mais compactos lateralmente).
  const widthRatio = breed === 'gato' ? 0.38 : 0.42;
  const widthCm = +(heightCm * widthRatio).toFixed(2);

  // Massa via fórmula alométrica usando o comprimento do tronco como proxy L.
  const coeffs = ALOMETRY[breed];
  const L = Math.max(lengthCm, 10); // guarda contra valores degenerados
  const weightEstimateKg = +(coeffs.a * Math.pow(L, coeffs.b)).toFixed(2);

  // Volume aproximado: elipsoide alongado para cães, mais arredondado para gatos.
  const a = lengthCm / 2;
  const b = widthCm / 2;
  const c = heightCm / 2;
  const ellipsoidFactor = breed === 'gato' ? 1.05 : 0.92; // gatos são mais densos
  const volumeCm3 = +((4 / 3) * Math.PI * a * b * c * ellipsoidFactor).toFixed(1);

  // Escala para impressão 3D: queremos uma miniatura de ~15-25 cm de altura.
  const targetHeightCm = 20;
  const scaleFactor = +(targetHeightCm / Math.max(heightCm, 1)).toFixed(4);

  // Bounding box escalado em coordenadas de modelo (centrado na origem).
  const half = { x: (lengthCm / 2) * scaleFactor, y: (heightCm / 2) * scaleFactor, z: (widthCm / 2) * scaleFactor };

  const notes: string[] = [];
  if (!options?.referenceObject) {
    notes.push('Sem objeto de referência detectado: dimensões estimadas via heurística (pode exigir ajuste manual).');
  }
  if (meta.estimatedWeightKg === undefined) {
    notes.push('Peso não fornecido; classe de raça inferida apenas por proporção w/h.');
  }
  if (scaleFactor > 3) {
    notes.push('Fator de escala muito alto: pet possivelmente fotografado de muito longe. Recomenda nova captura.');
  }

  const confidence = computeConfidence({ hasRef: !!options?.referenceObject, meta, ppc });

  return {
    lengthCm,
    heightCm,
    widthCm,
    weightEstimateKg,
    volumeCm3,
    confidence,
    boundingBox: {
      min: { x: -half.x, y: -half.y, z: -half.z },
      max: { x:  half.x, y:  half.y, z:  half.z },
    },
    scaleFactor,
    breedClass: breed,
    notes,
  };
}

function computeConfidence(args: {
  hasRef: boolean;
  meta: PetPhotoMetadata;
  ppc: number;
}): number {
  let score = 0.5;
  if (args.hasRef) score += 0.25;
  if (args.meta.sharpness !== undefined && args.meta.sharpness > 0.6) score += 0.1;
  if (args.meta.lighting !== undefined && args.meta.lighting > 0.5) score += 0.05;
  if (args.meta.estimatedWeightKg !== undefined) score += 0.1;
  if (args.ppc > 8 && args.ppc < 40) score += 0.05; // resolução plausível
  return Math.min(1, +score.toFixed(2));
}

/**
 * Converte uma estimativa dimensional em parâmetros de impressão 3D sugeridos.
 */
export function toPrintParams(estimate: DimensionalEstimate): {
  filamentGrams: number;
  printHours: number;
  recommendedLayerHeightMm: number;
  recommendedInfillPercent: number;
  suggestedMaterial: 'PLA' | 'PETG' | 'RESIN';
} {
  // PLA: ~1.24 g/cm³, com infill médio de 20%.
  const density = 1.24;
  const infillRatio = 0.2;
  const shellRatio  = 0.15;
  const effectiveVolume = estimate.volumeCm3 * (infillRatio + shellRatio);
  const filamentGrams = +(effectiveVolume * density).toFixed(1);

  // Estimativa de tempo: ~3 cm³/hora em FDM doméstica para peça detalhada.
  const printHours = +(estimate.volumeCm3 / 3).toFixed(2);

  // Quanto menor o pet, mais fino o layer para preservar detalhes.
  const recommendedLayerHeightMm =
    estimate.scaleFactor > 1.5 ? 0.08 : estimate.scaleFactor > 0.7 ? 0.12 : 0.16;

  const recommendedInfillPercent =
    estimate.weightEstimateKg > 15 ? 25 : 15; // pets grandes exigem mais resistência

  const suggestedMaterial: 'PLA' | 'PETG' | 'RESIN' =
    estimate.scaleFactor > 2 ? 'RESIN' : estimate.weightEstimateKg > 10 ? 'PETG' : 'PLA';

  return {
    filamentGrams,
    printHours,
    recommendedLayerHeightMm,
    recommendedInfillPercent,
    suggestedMaterial,
  };
}
