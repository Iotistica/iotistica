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

const FLOAT_EPSILON = 1e-9;
const TREND_EPSILON = 1e-6;
const MIN_SLOPE_THRESHOLD = 0.01;
const TREND_MEAN_RATIO = 0.01;
const TREND_STDDEV_THRESHOLD_FACTOR = 0.1;
const TREND_MEAN_THRESHOLD_FACTOR = 0.001;

function calculateTrendThreshold(stdDev: number, mean: number): number {
	return Math.max(
		stdDev * TREND_STDDEV_THRESHOLD_FACTOR,
		Math.abs(mean) * TREND_MEAN_THRESHOLD_FACTOR,
		TREND_EPSILON,
	);
}

export interface LinearRegressionResult {
	readonly slope: number;
	readonly intercept: number;
	readonly rSquared: number;
}

export type TrendDirection =
	| 'increasing'
	| 'decreasing'
	| 'stable';

export function linearRegression(values: readonly number[]): LinearRegressionResult | null {
	if (values.length < 2) {
		return null;
	}

	const n = values.length;
	let sumX = 0;
	let sumY = 0;
	let sumXY = 0;
	let sumX2 = 0;

	for (let i = 0; i < n; i++) {
		const x = i;
		const y = values[i];
		sumX += x;
		sumY += y;
		sumXY += x * y;
		sumX2 += x * x;
	}

	const denom = n * sumX2 - sumX * sumX;
	if (denom === 0) {
		return null;
	}

	const slope = (n * sumXY - sumX * sumY) / denom;
	const intercept = (sumY - slope * sumX) / n;

	const mean = sumY / n;
	let ssRes = 0;
	let ssTot = 0;

	for (let i = 0; i < n; i++) {
		const predicted = slope * i + intercept;
		const actual = values[i];
		const residual = actual - predicted;
		const totalDelta = actual - mean;
		ssRes += residual * residual;
		ssTot += totalDelta * totalDelta;
	}

	const rSquared = ssTot === 0 ? 0 : Math.max(0, Math.min(1, 1 - (ssRes / ssTot)));

	return {
		slope,
		intercept,
		rSquared,
	};
}

export interface Prediction {
	readonly current: number;
	readonly predictedNext: number;
	readonly trend: TrendDirection;
	readonly trendStrength: number; // 0-1 scale
	readonly confidence: number; // 0-1 scale
	timeToThreshold?: {
		readonly threshold: number;
		readonly estimatedSeconds: number;
		readonly confidence: number;
	};
}

export type PredictionResult =
	| { readonly success: true; readonly prediction: Prediction }
	| { readonly success: false; readonly reason: string };

export interface TimeToThresholdEstimate {
	readonly estimatedSeconds: number;
	readonly confidence: number;
}

export type TimeToThresholdResult =
	| { readonly success: true; readonly estimate: TimeToThresholdEstimate }
	| { readonly success: false; readonly reason: string };

function calculateTrendDirection(slope: number, stdDev: number, mean: number): TrendDirection {
	const threshold = calculateTrendThreshold(stdDev, mean);

	if (slope > threshold) {
		return 'increasing';
	}

	if (slope < -threshold) {
		return 'decreasing';
	}

	return 'stable';
}

function calculateTrendStrength(slope: number, stdDev: number, mean: number): number {
	const denom = Math.max(stdDev, Math.abs(mean) * TREND_MEAN_RATIO, FLOAT_EPSILON);
	const normalizedSlope = Math.abs(slope) / denom;
	return Math.min(1.0, normalizedSlope);
}

function calculatePredictionConfidence(n: number, slope: number, stdDev: number, rSquared: number): number {
	const normalizedRSquared = Math.max(0, rSquared);
	const slopeSignal = Math.min(1, Math.abs(slope) / (stdDev + FLOAT_EPSILON));
	const sizeFactor = Math.min(1, n / 20);
	return Math.max(0, Math.min(1, normalizedRSquared * slopeSignal * sizeFactor));
}

export function predictLinearResult(
	buffer: StatisticalBuffer,
	lookbackWindow: number = LINEAR_PREDICTOR_LOOKBACK,
): PredictionResult {
	if (buffer.size < 5) {
		return { success: false, reason: 'Insufficient buffer samples for linear prediction (need at least 5)' };
	}

	const recentValues = getRecentValues(buffer, lookbackWindow);
	if (recentValues.length < 5) {
		return { success: false, reason: 'Insufficient recent values for linear prediction (need at least 5)' };
	}

	const regression = linearRegression(recentValues);
	if (!regression) {
		return { success: false, reason: 'Linear regression failed (degenerate input)' };
	}
	const { slope, intercept, rSquared } = regression;
	const n = recentValues.length;

	const predictedNext = slope * n + intercept;
	const trend = calculateTrendDirection(slope, buffer.stdDev, buffer.mean);
	const trendStrength = calculateTrendStrength(slope, buffer.stdDev, buffer.mean);
	const confidence = calculatePredictionConfidence(recentValues.length, slope, buffer.stdDev, rSquared);

	return {
		success: true,
		prediction: {
			current: recentValues[recentValues.length - 1],
			predictedNext,
			trend,
			trendStrength,
			confidence,
		},
	};
}

export function predictLinear(
	buffer: StatisticalBuffer,
	lookbackWindow: number = LINEAR_PREDICTOR_LOOKBACK,
): Prediction | null {
	const result = predictLinearResult(buffer, lookbackWindow);
	return result.success ? result.prediction : null;
}

export function estimateLinearTimeToThresholdResult(
	buffer: StatisticalBuffer,
	threshold: number,
	samplingIntervalMs: number = 60000,
): TimeToThresholdResult {
	if (buffer.size < 10) {
		return { success: false, reason: 'Insufficient buffer samples for time-to-threshold estimation (need at least 10)' };
	}

	const recentValues = getRecentValues(buffer, TIME_TO_THRESHOLD_LOOKBACK);
	const regression = linearRegression(recentValues);
	if (!regression) {
		return { success: false, reason: 'Linear regression failed for time-to-threshold estimation' };
	}
	const { slope, intercept, rSquared } = regression;
	const n = recentValues.length;

	const current = recentValues[n - 1];
	const movingTowardThreshold =
		(slope > 0 && threshold > current)
		|| (slope < 0 && threshold < current);

	if (!movingTowardThreshold || Math.abs(slope) < MIN_SLOPE_THRESHOLD) {
		return { success: false, reason: 'Signal is not trending toward threshold with sufficient slope' };
	}

	const stepsToThreshold = (threshold - intercept) / slope;
	if (!Number.isFinite(stepsToThreshold) || stepsToThreshold < 0) {
		return { success: false, reason: 'Computed steps-to-threshold is invalid' };
	}

	const estimatedSeconds = Math.min(
		MAX_FORECAST_SECONDS,
		stepsToThreshold * (samplingIntervalMs / 1000),
	);

	const confidence = calculatePredictionConfidence(recentValues.length, slope, buffer.stdDev, rSquared);

	return {
		success: true,
		estimate: {
			estimatedSeconds: Math.max(0, estimatedSeconds),
			confidence,
		},
	};
}

export function estimateLinearTimeToThreshold(
	buffer: StatisticalBuffer,
	threshold: number,
	samplingIntervalMs: number = 60000,
): TimeToThresholdEstimate | null {
	const result = estimateLinearTimeToThresholdResult(buffer, threshold, samplingIntervalMs);
	return result.success ? result.estimate : null;
}

/**
 * Simple linear regression predictor
 * Uses recent values to predict next value
 */
export class LinearPredictor {
	predictResult(buffer: StatisticalBuffer, lookbackWindow: number = LINEAR_PREDICTOR_LOOKBACK): PredictionResult {
		return predictLinearResult(buffer, lookbackWindow);
	}

	/**
	* Predict next value using linear regression
	* @param buffer Statistical buffer with historical data
	* @param lookbackWindow Number of recent points to use (default: 20)
	*/
	predict(buffer: StatisticalBuffer, lookbackWindow: number = LINEAR_PREDICTOR_LOOKBACK): Prediction | null {
		return predictLinear(buffer, lookbackWindow);
	}

	estimateTimeToThresholdResult(
		buffer: StatisticalBuffer,
		threshold: number,
		samplingIntervalMs: number = 60000 // Default: 1 minute
	): TimeToThresholdResult {
		return estimateLinearTimeToThresholdResult(buffer, threshold, samplingIntervalMs);
	}
	
	/**
	* Estimate time until threshold is reached
	*/
	estimateTimeToThreshold(
		buffer: StatisticalBuffer,
		threshold: number,
		samplingIntervalMs: number = 60000 // Default: 1 minute
	): TimeToThresholdEstimate | null {
		return estimateLinearTimeToThreshold(buffer, threshold, samplingIntervalMs);
	}
}

/**
 * Exponential moving average predictor (faster, but simpler)
 */
export class EMAPredictor {
	private readonly alpha: number; // Smoothing factor (0-1)
	
	constructor(alpha: number = 0.3) {
		if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
			throw new RangeError('alpha must be between 0 and 1');
		}
		this.alpha = alpha;
	}
	
	/**
	* Predict next value using EMA
	*/
	predictResult(buffer: StatisticalBuffer): PredictionResult {
		if (buffer.size < 3) {
			return { success: false, reason: 'Insufficient buffer samples for EMA prediction (need at least 3)' };
		}

		const recentValues = getRecentValues(buffer, EMA_PREDICTOR_LOOKBACK);
		if (recentValues.length < 3) {
			return { success: false, reason: 'Insufficient recent values for EMA prediction (need at least 3)' };
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
		let trend: TrendDirection;
		const trendThreshold = calculateTrendThreshold(buffer.stdDev, buffer.mean);
		if (Math.abs(change) < trendThreshold) {
			trend = 'stable';
		} else if (change > 0) {
			trend = 'increasing';
		} else {
			trend = 'decreasing';
		}

		// Simple confidence based on recent variance
		const recentVariance = this.calculateRecentVariance(recentValues);
		const varianceDenom = Math.max(buffer.stdDev * buffer.stdDev, FLOAT_EPSILON);
		const ratio = recentVariance / varianceDenom;
		const confidence = Math.exp(-ratio);

		const trendDenom = Math.max(buffer.stdDev, Math.abs(buffer.mean) * TREND_MEAN_RATIO, FLOAT_EPSILON);
		return {
			success: true,
			prediction: {
				current,
				predictedNext,
				trend,
				trendStrength: Math.min(1, Math.abs(change) / trendDenom),
				confidence,
			},
		};
	}

	predict(buffer: StatisticalBuffer): Prediction | null {
		const result = this.predictResult(buffer);
		return result.success ? result.prediction : null;
	}
	
	private calculateRecentVariance(values: readonly number[]): number {
		const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
		const variance = values.reduce((sum, val) => {
			const delta = val - mean;
			return sum + delta * delta;
		}, 0) / values.length;
		return variance;
	}
}

// Edge best practice: do not run forecasts on every sample.
// Use cadence + change detection to limit work and noise on constrained devices.
export interface ForecastCadenceConfig {
	readonly minIntervalMs?: number; // Minimum time between runs
	readonly minSamples?: number; // Minimum samples before running
	readonly minTrendChange?: number; // Minimum trendStrength delta to publish (0-1)
	readonly minConfidenceDelta?: number; // Minimum confidence delta to publish (0-1)
	readonly minPredictionDelta?: number; // Minimum relative predictedNext delta to publish (0-1 fraction)
}

export interface ForecastCadenceState {
	lastRunAt?: number;
	lastPublished?: Prediction;
}

// Minimum confidence required before attaching time-to-threshold details
export const MIN_TIME_TO_THRESHOLD_CONFIDENCE = 0.5; // Never attach below 0.3

export function shouldRunForecast(
	buffer: StatisticalBuffer,
	state: Readonly<ForecastCadenceState>,
	config: Readonly<ForecastCadenceConfig>,
	now: number = Date.now()
): boolean {
	const minSamples = config.minSamples ?? 10;
	if (buffer.size < minSamples) {
		return false;
	}

	const minInterval = config.minIntervalMs ?? 60000; // Default: 1 minute cadence
	if (state.lastRunAt !== undefined && now - state.lastRunAt < minInterval) {
		return false;
	}

	return true;
}

export function shouldPublishForecast(
	prediction: Prediction | null,
	state: Readonly<ForecastCadenceState>,
	config: Readonly<ForecastCadenceConfig>
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
		Math.abs(prediction.trendStrength - previous.trendStrength) >= trendDelta;

	const confidenceChanged = Math.abs(prediction.confidence - previous.confidence) >= confidenceDelta;

	const predictedChange = Math.abs(prediction.predictedNext - previous.predictedNext);
	const predictedBaseline = Math.max(1, Math.abs(previous.predictedNext));
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
