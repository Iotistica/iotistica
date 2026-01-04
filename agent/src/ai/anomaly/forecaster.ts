/**
 * FORECASTER - TIME SERIES PREDICTION
 * =====================================
 * 
 * Simple forecasting algorithms for edge devices:
 * - Linear regression prediction
 * - Moving average smoothing
 * - Time-to-threshold estimation
 * - Confidence scoring
 */

import type { StatisticalBuffer } from './types';
import { getRecentValues } from './buffer';

// Window sizes are intentionally different:
// - Linear lookback balances smoothing with sensitivity for edge noise.
// - Time-to-threshold uses a longer window for stability.
// - EMA uses a short window for responsiveness.
export const LINEAR_PREDICTOR_LOOKBACK = 20;
export const TIME_TO_THRESHOLD_LOOKBACK = 30;
export const EMA_PREDICTOR_LOOKBACK = 10;
export const MAX_FORECAST_SECONDS = 24 * 60 * 60; // Cap at 24h to avoid unrealistic horizons

export interface Prediction {
	current: number;
	predicted_next: number;
	trend: 'increasing' | 'decreasing' | 'stable';
	trend_strength: number; // 0-1 scale
	confidence: number; // 0-1 scale
	time_to_threshold?: {
		threshold: number;
		estimated_seconds: number;
		confidence: number;
	};
}

/**
 * Simple linear regression predictor
 * Uses recent values to predict next value
 */
export class LinearPredictor {
	/**
	 * Predict next value using linear regression
	 * @param buffer Statistical buffer with historical data
	 * @param lookbackWindow Number of recent points to use (default: 20)
	 */
	predict(buffer: StatisticalBuffer, lookbackWindow: number = LINEAR_PREDICTOR_LOOKBACK): Prediction | null {
		if (buffer.size < 5) {
			return null; // Need minimum data
		}
		
		const recentValues = getRecentValues(buffer, lookbackWindow);
		if (recentValues.length < 5) {
			return null;
		}
		
		// Simple linear regression: y = mx + b
		const n = recentValues.length;
		let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
		
		for (let i = 0; i < n; i++) {
			const x = i; // Time index
			const y = recentValues[i];
			sumX += x;
			sumY += y;
			sumXY += x * y;
			sumX2 += x * x;
		}
		
		const denom = (n * sumX2 - sumX * sumX);
		if (denom === 0) {
			return null;
		}
		const slope = (n * sumXY - sumX * sumY) / denom;
		const intercept = (sumY - slope * sumX) / n;
		
		// Predict next value (time index = n)
		const predictedNext = slope * n + intercept;
		
		// Calculate trend
		const trend = this.calculateTrend(slope, buffer.stdDev, buffer.mean);
		const trendStrength = this.calculateTrendStrength(slope, buffer.stdDev, buffer.mean);
		
		// Calculate confidence based on R-squared
		const confidence = this.calculateConfidence(recentValues, slope, intercept, buffer.stdDev);
		
		return {
			current: recentValues[recentValues.length - 1],
			predicted_next: predictedNext,
			trend: trend.direction,
			trend_strength: trendStrength,
			confidence
		};
	}
	
	/**
	 * Estimate time until threshold is reached
	 */
	estimateTimeToThreshold(
		buffer: StatisticalBuffer,
		threshold: number,
		samplingIntervalMs: number = 60000 // Default: 1 minute
	): { estimated_seconds: number; confidence: number } | null {
		if (buffer.size < 10) {
			return null;
		}
		
		const recentValues = getRecentValues(buffer, TIME_TO_THRESHOLD_LOOKBACK);
		const n = recentValues.length;
		
		// Linear regression
		let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
		for (let i = 0; i < n; i++) {
			sumX += i;
			sumY += recentValues[i];
			sumXY += i * recentValues[i];
			sumX2 += i * i;
		}
		
		const denom = (n * sumX2 - sumX * sumX);
		if (denom === 0) {
			return null;
		}
		const slope = (n * sumXY - sumX * sumY) / denom;
		const intercept = (sumY - slope * sumX) / n;
		
		// If not trending toward threshold, return null
		const current = recentValues[n - 1];
		const movingTowardThreshold = 
			(slope > 0 && threshold > current) || 
			(slope < 0 && threshold < current);
		
		if (!movingTowardThreshold || Math.abs(slope) < 0.01) {
			return null; // Not trending toward threshold
		}
		
		// Calculate time to reach threshold
		// threshold = slope * t + intercept
		// t = (threshold - intercept) / slope
		const stepsToThreshold = (threshold - intercept) / slope;
		if (!Number.isFinite(stepsToThreshold) || stepsToThreshold < 0) {
			return null;
		}

		const estimatedSeconds = Math.min(
			MAX_FORECAST_SECONDS,
			stepsToThreshold * (samplingIntervalMs / 1000)
		);
		
		// Confidence based on how linear the trend is
		const confidence = this.calculateConfidence(recentValues, slope, intercept, buffer.stdDev);
		
		return {
			estimated_seconds: Math.max(0, estimatedSeconds),
			confidence
		};
	}
	
	/**
	 * Calculate trend direction
	 */
	private calculateTrend(slope: number, stdDev: number, mean: number): { direction: 'increasing' | 'decreasing' | 'stable' } {
		const threshold = Math.max(
			stdDev * 0.1,
			Math.abs(mean) * 0.001,
			1e-6
		);
		
		if (slope > threshold) {
			return { direction: 'increasing' };
		} else if (slope < -threshold) {
			return { direction: 'decreasing' };
		} else {
			return { direction: 'stable' };
		}
	}
	
	/**
	 * Calculate trend strength (0-1)
	 */
	private calculateTrendStrength(slope: number, stdDev: number, mean: number): number {
		const denom = Math.max(stdDev, Math.abs(mean) * 0.01, 1e-9);
		const normalizedSlope = Math.abs(slope) / denom;
		return Math.min(1.0, normalizedSlope);
	}
	
	/**
	 * Calculate prediction confidence using R-squared
	 */
	private calculateConfidence(values: number[], slope: number, intercept: number, stdDev: number): number {
		const n = values.length;
		
		// Calculate mean
		const mean = values.reduce((sum, val) => sum + val, 0) / n;
		
		// Calculate R-squared
		let ssRes = 0; // Sum of squared residuals
		let ssTot = 0; // Total sum of squares
		
		for (let i = 0; i < n; i++) {
			const predicted = slope * i + intercept;
			const actual = values[i];
			ssRes += Math.pow(actual - predicted, 2);
			ssTot += Math.pow(actual - mean, 2);
		}
		
		if (ssTot === 0) return 0;
		
		const rSquared = 1 - (ssRes / ssTot);
		const slopeSignal = Math.min(1, Math.abs(slope) / (stdDev + 1e-9));
		const sizeFactor = Math.min(1, n / 20);
		return Math.max(0, Math.min(1, rSquared * slopeSignal * sizeFactor));
	}
}

/**
 * Exponential moving average predictor (faster, but simpler)
 */
export class EMAPredictor {
	private alpha: number; // Smoothing factor (0-1)
	
	constructor(alpha: number = 0.3) {
		this.alpha = alpha;
	}
	
	/**
	 * Predict next value using EMA
	 */
	predict(buffer: StatisticalBuffer): Prediction | null {
		if (buffer.size < 3) {
			return null;
		}

		const recentValues = getRecentValues(buffer, EMA_PREDICTOR_LOOKBACK);
		if (recentValues.length < 3) {
			return null;
		}
		
		// Calculate EMA
		let ema = recentValues[0];
		for (let i = 1; i < recentValues.length; i++) {
			ema = this.alpha * recentValues[i] + (1 - this.alpha) * ema;
		}
		
		// Simple trend detection
		const current = recentValues[recentValues.length - 1];
		const previous = recentValues[recentValues.length - 2];
		const change = current - previous;
		
		// Predict next value (extrapolate)
		const predictedNext = ema + change;
		
		// Determine trend
		let trend: 'increasing' | 'decreasing' | 'stable';
		const trendThreshold = Math.max(buffer.stdDev * 0.1, Math.abs(buffer.mean) * 0.001, 1e-6);
		if (Math.abs(change) < trendThreshold) {
			trend = 'stable';
		} else if (change > 0) {
			trend = 'increasing';
		} else {
			trend = 'decreasing';
		}
		
		// Simple confidence based on recent variance
		const recentVariance = this.calculateRecentVariance(recentValues);
		const varianceDenom = Math.max(buffer.stdDev * buffer.stdDev, 1e-9);
		const ratio = recentVariance / varianceDenom;
		const confidence = Math.exp(-ratio);
		
		const trendDenom = Math.max(buffer.stdDev, Math.abs(buffer.mean) * 0.01, 1e-9);
		return {
			current,
			predicted_next: predictedNext,
			trend,
			trend_strength: Math.min(1, Math.abs(change) / trendDenom),
			confidence
		};
	}
	
	private calculateRecentVariance(values: number[]): number {
		const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
		const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
		return variance;
	}
}

// Edge best practice: do not run forecasts on every sample.
// Use cadence + change detection to limit work and noise on constrained devices.
export interface ForecastCadenceConfig {
	minIntervalMs?: number; // Minimum time between runs
	minSamples?: number; // Minimum samples before running
	minTrendChange?: number; // Minimum trend_strength delta to publish (0-1)
	minConfidenceDelta?: number; // Minimum confidence delta to publish (0-1)
	minPredictionDelta?: number; // Minimum relative predicted_next delta to publish (0-1 fraction)
}

export interface ForecastCadenceState {
	lastRunAt?: number;
	lastPublished?: Prediction;
}

// Minimum confidence required before attaching time-to-threshold details
export const MIN_TIME_TO_THRESHOLD_CONFIDENCE = 0.5; // Never attach below 0.3

export function shouldRunForecast(
	buffer: StatisticalBuffer,
	state: ForecastCadenceState,
	config: ForecastCadenceConfig,
	now: number = Date.now()
): boolean {
	const minSamples = config.minSamples ?? 10;
	if (buffer.size < minSamples) {
		return false;
	}

	const minInterval = config.minIntervalMs ?? 60000; // Default: 1 minute cadence
	if (state.lastRunAt && now - state.lastRunAt < minInterval) {
		return false;
	}

	return true;
}

export function shouldPublishForecast(
	prediction: Prediction | null,
	state: ForecastCadenceState,
	config: ForecastCadenceConfig
): boolean {
	if (!prediction) {
		return false;
	}

	const previous = state.lastPublished;
	if (!previous) {
		return true; // First result
	}

	const trendDelta = config.minTrendChange ?? 0.1;
	const confidenceDelta = config.minConfidenceDelta ?? 0.1;
	const predictionDelta = config.minPredictionDelta ?? 0.05; // 5% change

	const trendChanged =
		prediction.trend !== previous.trend ||
		Math.abs(prediction.trend_strength - previous.trend_strength) >= trendDelta;

	const confidenceChanged = Math.abs(prediction.confidence - previous.confidence) >= confidenceDelta;

	const predictedChange = Math.abs(prediction.predicted_next - previous.predicted_next);
	const predictedBaseline = Math.max(1, Math.abs(previous.predicted_next));
	const predictionShifted = predictedChange / predictedBaseline >= predictionDelta;

	return trendChanged || confidenceChanged || predictionShifted;
}

export function recordForecastResult(
	state: ForecastCadenceState,
	prediction: Prediction | null,
	now: number = Date.now()
): void {
	state.lastRunAt = now;
	if (prediction) {
		state.lastPublished = prediction;
	}
}
