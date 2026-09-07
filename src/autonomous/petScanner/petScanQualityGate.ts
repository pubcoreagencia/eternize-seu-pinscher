// petScanQualityGate.ts
// Quality gate pipeline for the Pet Scanner module of "eternize-seu-pinscher".
// Aggregates multi-signal quality metrics from the pet photo analyzer and
// dimensional estimator to decide whether the generated STL is ready for
// export to the additive manufacturing (3D printing) stage.
//
// This module is part of Setor 6: Manufatura Afetiva, Pets & Esculturas 3D.

import { PetPhotoQualityAnalyzer, PhotoQualityReport } from "../../modules/petScanner/petPhotoQualityAnalyzer";
import { PetDimensionalEstimator, DimensionalEstimate } from "./petDimensionalEstimator";

export type QualityTier = "REJECTED" | "ACCEPTABLE" | "GOOD" | "EXCELLENT";

export interface QualityGateConfig {
  minOverallScore: number;       // 0..1
  minSharpness: number;          // 0..1
  minCoverage: number;           // 0..1 (subject coverage)
  maxPoseAmbiguity: number;      // 0..1 (lower is better)
  minConfidence: number;         // 0..1 (dimensional estimator)
  requireConsistentUnits: boolean;
  minimumWallThicknessMm: number;
}

export const DEFAULT_QUALITY_GATE_CONFIG: QualityGateConfig = {
  minOverallScore: 0.62,
  minSharpness: 0.45,
  minCoverage: 0.35,
  maxPoseAmbiguity: 0.7,
  minConfidence: 0.55,
  requireConsistentUnits: true,
  minimumWallThicknessMm: 1.2,
};

export interface QualityGateResult {
  passed: boolean;
  tier: QualityTier;
  overallScore: number;
  reasons: string[];
  warnings: string[];
  recommendedAction: "EXPORT_STL" | "REQUEST_BETTER_PHOTO" | "MANUAL_REVIEW";
  printable: boolean;
  estimatedBoundingBoxMm?: { width: number; height: number; depth: number };
  recommendedWallThicknessMm?: number;
}

interface QualityGateDeps {
  analyzer: PetPhotoQualityAnalyzer;
  estimator: PetDimensionalEstimator;
  config?: Partial<QualityGateConfig>;
}

export class PetScanQualityGate {
  private readonly analyzer: PetPhotoQualityAnalyzer;
  private readonly estimator: PetDimensionalEstimator;
  private readonly config: QualityGateConfig;

  constructor(deps: QualityGateDeps) {
    if (!deps || !deps.analyzer || !deps.estimator) {
      throw new Error("[PetScanQualityGate] analyzer and estimator are required dependencies");
    }
    this.analyzer = deps.analyzer;
    this.estimator = deps.estimator;
    this.config = { ...DEFAULT_QUALITY_GATE_CONFIG, ...(deps.config || {}) };
  }

  /**
   * Runs the full quality gate for a pet photo + optional reference dimensions.
   * Returns a structured report used to gate the STL export pipeline.
   */
  async evaluate(input: {
    imageData: Buffer | Uint8Array | string; // path, base64 or raw buffer
    referenceDimensions?: { species: "dog" | "cat"; weightKg?: number; heightCm?: number; lengthCm?: number };
  }): Promise<QualityGateResult> {
    const reasons: string[] = [];
    const warnings: string[] = [];

    // 1) Photo quality analysis
    let photoReport: PhotoQualityReport;
    try {
      photoReport = await this.analyzer.analyze(input.imageData);
    } catch (err) {
      return {
        passed: false,
        tier: "REJECTED",
        overallScore: 0,
        reasons: [`Photo analysis failed: ${(err as Error).message}`],
        warnings: [],
        recommendedAction: "REQUEST_BETTER_PHOTO",
        printable: false,
      };
    }

    if (photoReport.overallScore < this.config.minOverallScore) {
      reasons.push(
        `Photo overall score ${photoReport.overallScore.toFixed(2)} below threshold ${this.config.minOverallScore}`,
      );
    }
    if (photoReport.sharpness < this.config.minSharpness) {
      reasons.push(
        `Image sharpness ${photoReport.sharpness.toFixed(2)} below threshold ${this.config.minSharpness}. Photo is too blurry.`,
      );
    }
    if (photoReport.subjectCoverage < this.config.minCoverage) {
      reasons.push(
        `Subject coverage ${(photoReport.subjectCoverage * 100).toFixed(1)}% below threshold ${(this.config.minCoverage * 100).toFixed(1)}%.`,
      );
    }
    if (photoReport.poseAmbiguity > this.config.maxPoseAmbiguity) {
      reasons.push(
        `Pose ambiguity ${photoReport.poseAmbiguity.toFixed(2)} exceeds max ${this.config.maxPoseAmbiguity}. Pet pose is unclear.`,
      );
    }

    if (photoReport.warnings && photoReport.warnings.length > 0) {
      warnings.push(...photoReport.warnings);
    }

    // 2) Dimensional estimation
    let dimensional: DimensionalEstimate;
    try {
      dimensional = await this.estimator.estimate({
        species: input.referenceDimensions?.species ?? "dog",
        weightKg: input.referenceDimensions?.weightKg,
        heightCm: input.referenceDimensions?.heightCm,
        lengthCm: input.referenceDimensions?.lengthCm,
      });
    } catch (err) {
      reasons.push(`Dimensional estimation failed: ${(err as Error).message}`);
      return {
        passed: false,
        tier: "REJECTED",
        overallScore: photoReport.overallScore,
        reasons,
        warnings,
        recommendedAction: "MANUAL_REVIEW",
        printable: false,
      };
    }

    if (this.config.requireConsistentUnits && !dimensional.unitsConsistent) {
      reasons.push("Dimensional units are inconsistent. Reference measurements must be all metric.");
    }
    if (dimensional.confidence < this.config.minConfidence) {
      reasons.push(
        `Dimensional confidence ${dimensional.confidence.toFixed(2)} below threshold ${this.config.minConfidence}.`,
      );
    }
    if (dimensional.suggestedWallThicknessMm < this.config.minimumWallThicknessMm) {
      warnings.push(
        `Suggested wall thickness ${dimensional.suggestedWallThicknessMm.toFixed(2)}mm is below the printable minimum ${this.config.minimumWallThicknessMm}mm. Reinforce in post-processing.`,
      );
    }

    // 3) Composite score: weighted blend
    const composite =
      photoReport.overallScore * 0.55 +
      dimensional.confidence * 0.3 +
      (1 - photoReport.poseAmbiguity) * 0.15;

    const tier = this.resolveTier(composite, reasons.length === 0);
    const passed = reasons.length === 0 && tier !== "REJECTED";

    let recommendedAction: QualityGateResult["recommendedAction"];
    if (!passed) {
      recommendedAction = photoReport.overallScore < this.config.minOverallScore
        ? "REQUEST_BETTER_PHOTO"
        : "MANUAL_REVIEW";
    } else if (warnings.length > 0 || tier === "ACCEPTABLE") {
      recommendedAction = "MANUAL_REVIEW";
    } else {
      recommendedAction = "EXPORT_STL";
    }

    return {
      passed,
      tier,
      overallScore: Number(composite.toFixed(3)),
      reasons,
      warnings,
      recommendedAction,
      printable: passed && dimensional.suggestedWallThicknessMm >= this.config.minimumWallThicknessMm,
      estimatedBoundingBoxMm: dimensional.boundingBoxMm,
      recommendedWallThicknessMm: Math.max(
        dimensional.suggestedWallThicknessMm,
        this.config.minimumWallThicknessMm,
      ),
    };
  }

  private resolveTier(score: number, noBlockingReasons: boolean): QualityTier {
    if (!noBlockingReasons) return "REJECTED";
    if (score >= 0.85) return "EXCELLENT";
    if (score >= 0.72) return "GOOD";
    if (score >= this.config.minOverallScore) return "ACCEPTABLE";
    return "REJECTED";
  }
}

export default PetScanQualityGate;
