export interface PetPhoto {
  id: string;
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
  dpi?: number;
}

export interface ScanReadiness {
  ready: boolean;
  score: number; // 0-100
  issues: string[];
  suggestedDpi: number;
}

export interface AffectiveProfile {
  petName: string;
  breed: string;
  personalityTraits: string[];
  poeticDescription: string;
  emotionalTone: 'nostalgic' | 'joyful' | 'serene' | 'playful';
}

export interface PrintConfig {
  scale: number; // 1:1, 1:2, etc
  material: 'resin' | 'filament' | 'fullColorSandstone';
  baseType: 'flat' | 'round' | 'custom';
  colorMode: 'monochrome' | 'fullColor' | 'painted';
}

export class NeuralPetPreprocessor {
  private readonly MIN_DIMENSION = 800;
  private readonly TARGET_DPI = 300;
  private readonly QUALITY_THRESHOLD = 0.7;

  validatePhoto(photo: PetPhoto): ScanReadiness {
    const issues: string[] = [];
    let score = 100;

    if (photo.width < this.MIN_DIMENSION || photo.height < this.MIN_DIMENSION) {
      issues.push(`Resolução mínima não atendida: ${photo.width}x${photo.height}`);
      score -= 30;
    }

    if (!photo.dpi || photo.dpi < this.TARGET_DPI) {
      issues.push(`DPI insuficiente para reconstrução 3D: ${photo.dpi || 'unknown'}`);
      score -= 25;
    }

    if (!['image/jpeg', 'image/png', 'image/webp'].includes(photo.mimeType)) {
      issues.push(`Formato não suportado: ${photo.mimeType}`);
      score -= 20;
    }

    const sharpness = this.estimateSharpness(photo);
    if (sharpness < this.QUALITY_THRESHOLD) {
      issues.push('Imagem possivelmente desfocada para modelagem 3D');
      score -= 25;
    }

    return {
      ready: score >= 70,
      score: Math.max(0, Math.min(100, score)),
      issues,
      suggestedDPI: this.TARGET_DPI
    };
  }

  enhanceForScan(photo: PetPhoto): PetPhoto {
    // Simulação de melhoria neural: ajuste de contraste e nitidez
    const enhancedBuffer = this.applyNeuralEnhancement(photo.buffer);
    return {
      ...photo,
      buffer: enhancedBuffer,
      dpi: Math.max(photo.dpi || 0, this.TARGET_DPI)
    };
  }

  generateAffectiveProfile(photo: PetPhoto, userInput?: { name?: string; breed?: string }): AffectiveProfile {
    const traits = this.inferTraits(photo);
    const tone = this.selectEmotionalTone(photo);
    
    return {
      petName: userInput?.name || 'Anjo Eterno',
      breed: userInput?.breed || 'Raça Não Informada',
      personalityTraits: traits,
      poeticDescription: this.buildPoeticDescription(traits, tone),
      emotionalTone: tone
    };
  }

  buildPrintConfig(readiness: ScanReadiness, budget: 'low' | 'medium' | 'high'): PrintConfig {
    const material = budget === 'high' ? 'fullColorSandstone' : budget === 'medium' ? 'resin' : 'filament';
    const scale = readiness.score > 85 ? 1 : 0.8;
    
    return {
      scale,
      material,
      baseType: 'round',
      colorMode: material === 'fullColorSandstone' ? 'fullColor' : 'monochrome'
    };
  }

  private estimateSharpness(photo: PetPhoto): number {
    // Placeholder para análise de Laplacian edge detection
    // Em produção, integrar com OpenCV ou similar
    return photo.dpi && photo.dpi >= this.TARGET_DPI ? 0.85 : 0.6;
  }

  private applyNeuralEnhancement(buffer: Buffer): Buffer {
    // Simulação de pipeline neural de melhoria
    // Em produção: integrar com TensorFlow.js ou API de visão computacional
    return Buffer.from(buffer); // Retorna cópia processada
  }

  private inferTraits(photo: PetPhoto): string[] {
    const baseTraits = ['lealdade', 'energia', 'presença']; 
    if (photo.width > 1200) baseTraits.push('detalhe expressivo');
    return baseTraits;
  }

  private selectEmotionalTone(photo: PetPhoto): AffectiveProfile['emotionalTone'] {
    const tones: AffectiveProfile['emotionalTone'][] = ['nostalgic', 'joyful', 'serene', 'playful'];
    return tones[Math.floor(Math.random() * tones.length)];
  }

  private buildPoeticDescription(traits: string[], tone: AffectiveProfile['emotionalTone']): string {
    const templates = {
      nostalgic: `Uma essência de ${traits[0]} e ${traits[1]} que transcende o tempo, eternizada em camadas de memória.`,
      joyful: `Energia pura de ${traits[1]} capturada para sempre, brilhando em cada camada impressa.`,
      serene: `A calma de ${traits[2]} materializada em formas que acolhem e confortam.`,
      playful: `A alegria de ${traits[1]} congelada em instantes que ganham vida tridimensional.`
    };
    return templates[tone];
  }
}

// Factory para integração com kernel neural-os
export function createNeuralPreprocessor(): NeuralPetPreprocessor {
  return new NeuralPetPreprocessor();
}
