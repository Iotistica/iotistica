/**
 * Device Suggestions Service
 * 
 * Generates contextual suggestions for device operations based on current view and device state.
 * Supports views like metrics, logs, endpoints, config with intelligent recommendations.
 */

import { z } from 'zod';
import logger from '../../utils/logger';

// Context from the device page
interface DeviceContext {
  deviceUuid: string;
  deviceName: string;
  deviceView: 'metrics' | 'logs' | 'endpoints' | 'devices' | 'config' | 'settings' | 'jobs' | 'applications';
  userPrompt: string;
}

// Device suggestion response
interface DeviceSuggestion {
  id: string;
  action: string;
  description: string;
  severity: 'info' | 'warning' | 'critical';
  estimatedImpact: string;
  recommendedNextSteps: string[];
}

interface GenerateDeviceSuggestionsOptions {
  context: DeviceContext;
  requestId?: string;
  userId?: string;
}

interface GenerateDeviceSuggestionsResult {
  suggestions: DeviceSuggestion[];
  viewContext: string;
  analysisDetails: string;
  recommendedActions: string[];
}

/**
 * Extract intent from user prompt and device view
 */
function analyzeUserIntent(prompt: string, view: string): string {
  const lowerPrompt = prompt.toLowerCase();
  
  // View-specific intent detection
  if (view === 'metrics') {
    if (/high|spike|elevated|surge|peak/.test(lowerPrompt)) return 'performance-analysis';
    if (/memory|ram|leak/.test(lowerPrompt)) return 'memory-analysis';
    if (/cpu|processing/.test(lowerPrompt)) return 'cpu-analysis';
    if (/optimize|improve|efficient/.test(lowerPrompt)) return 'optimization';
  }
  
  if (view === 'logs') {
    if (/error|failure|failed|crash/.test(lowerPrompt)) return 'error-analysis';
    if (/pattern|recurring|frequent/.test(lowerPrompt)) return 'pattern-detection';
    if (/warning|alert/.test(lowerPrompt)) return 'alert-analysis';
  }
  
  if (view === 'endpoints' || view === 'devices') {
    if (/offline|connection|down|unreachable/.test(lowerPrompt)) return 'connectivity-diagnosis';
    if (/slow|latency|response/.test(lowerPrompt)) return 'performance-analysis';
    if (/health|status/.test(lowerPrompt)) return 'health-check';
  }
  
  if (view === 'config' || view === 'settings') {
    if (/secure|security|vulnerability/.test(lowerPrompt)) return 'security-audit';
    if (/optimize|optimal/.test(lowerPrompt)) return 'optimization';
    if (/review|audit/.test(lowerPrompt)) return 'configuration-review';
  }
  
  return 'general-inquiry';
}

/**
 * Generate contextual suggestions based on device view and prompt
 */
function generateContextualSuggestions(
  deviceName: string,
  view: string,
  intent: string,
): DeviceSuggestion[] {
  const suggestions: DeviceSuggestion[] = [];
  
  switch (view) {
    case 'metrics':
      if (intent === 'performance-analysis' || intent === 'cpu-analysis') {
        suggestions.push({
          id: 'check-cpu-processes',
          action: 'Identify top CPU consumers',
          description: `Review processes consuming CPU on ${deviceName} over the past hour`,
          severity: 'warning',
          estimatedImpact: 'Helps identify runaway processes causing performance issues',
          recommendedNextSteps: [
            'Check container resource limits',
            'Look for spike correlation in logs',
            'Consider scaling or optimization'
          ],
        });
        
        suggestions.push({
          id: 'check-kernel-time',
          action: 'Analyze kernel CPU time',
          description: 'Check if high CPU is user-space or kernel-space related',
          severity: 'warning',
          estimatedImpact: 'Indicates whether problem is in application or system',
          recommendedNextSteps: [
            'Compare against baseline CPU usage',
            'Check for system calls or I/O operations',
            'Review recent deployments'
          ],
        });
      }
      
      if (intent === 'memory-analysis') {
        suggestions.push({
          id: 'check-memory-usage',
          action: 'Analyze memory consumption',
          description: `Review memory usage patterns on ${deviceName}`,
          severity: 'critical',
          estimatedImpact: 'Memory pressure can cause application crashes or slowdowns',
          recommendedNextSteps: [
            'Identify memory leak suspects',
            'Check container swap usage',
            'Review garbage collection logs',
            'Consider increasing memory limit or pods'
          ],
        });
      }
      
      if (intent === 'optimization') {
        suggestions.push({
          id: 'resource-utilization-review',
          action: 'Review resource utilization baseline',
          description: `Establish normal CPU, memory, and disk usage patterns for ${deviceName}`,
          severity: 'info',
          estimatedImpact: 'Helps set proper alerts and identify anomalies early',
          recommendedNextSteps: [
            'Compare week-over-week metrics',
            'Set alert thresholds at 70-80% of capacity',
            'Plan scaling based on growth trajectory'
          ],
        });
      }
      break;
      
    case 'logs':
      if (intent === 'error-analysis') {
        suggestions.push({
          id: 'error-trend-analysis',
          action: 'Analyze recent error trends',
          description: `Identify common error patterns and root causes in ${deviceName} logs`,
          severity: 'warning',
          estimatedImpact: 'Helps prioritize fixes for most impactful errors',
          recommendedNextSteps: [
            'Group errors by type/component',
            'Correlate with metrics (CPU, memory, disk)',
            'Check recent configuration or code changes'
          ],
        });
        
        suggestions.push({
          id: 'error-rate-baseline',
          action: 'Establish error rate baseline',
          description: 'Determine normal vs. elevated error rates for alerting',
          severity: 'info',
          estimatedImpact: 'Enables proactive detection of degradation',
          recommendedNextSteps: [
            'Compare 24-hour vs 7-day error rates',
            'Set alerts for 2x baseline errors',
            'Create runbooks for top 5 error types'
          ],
        });
      }
      
      if (intent === 'pattern-detection') {
        suggestions.push({
          id: 'recurring-error-detection',
          action: 'Identify recurring errors',
          description: `Find patterns in ${deviceName} logs suggesting systematic issues`,
          severity: 'warning',
          estimatedImpact: 'Recurring errors indicate systemic problems needing root cause fix',
          recommendedNextSteps: [
            'Count error frequency and time distribution',
            'Check for correlation with deployments/changes',
            'Investigate underlying component health'
          ],
        });
      }
      break;
      
    case 'endpoints':
    case 'devices':
      if (intent === 'connectivity-diagnosis') {
        suggestions.push({
          id: 'vendor-connection-status',
          action: 'Check endpoint connectivity status',
          description: `Review connection history and failover events for endpoints on ${deviceName}`,
          severity: 'critical',
          estimatedImpact: 'Offline endpoints cause data gaps and trigger cascading issues',
          recommendedNextSteps: [
            'Check network connectivity from device',
            'Verify endpoint credentials and configuration',
            'Review timeout and retry settings',
            'Restart connection if prolonged outage'
          ],
        });
        
        suggestions.push({
          id: 'reconnection-timing',
          action: 'Analyze reconnection patterns',
          description: 'Identify if connectivity issues happen at specific times',
          severity: 'warning',
          estimatedImpact: 'Scheduled issues suggest network or maintenance patterns',
          recommendedNextSteps: [
            'Correlate with network maintenance windows',
            'Check for rate limiting or timeout issues',
            'Consider connection pooling adjustments'
          ],
        });
      }
      
      if (intent === 'health-check') {
        suggestions.push({
          id: 'endpoint-health-assessment',
          action: 'Assess endpoint health',
          description: `Comprehensive health check for all endpoints on ${deviceName}`,
          severity: 'info',
          estimatedImpact: 'Early detection of failing endpoints prevents data loss',
          recommendedNextSteps: [
            'Verify response times are normal',
            'Check error rates and patterns',
            'Validate data freshness',
            'Test alarm/alert configurations'
          ],
        });
      }
      break;
      
    case 'config':
    case 'settings':
      if (intent === 'security-audit') {
        suggestions.push({
          id: 'security-configuration-review',
          action: 'Review security settings',
          description: `Audit security configuration for ${deviceName}`,
          severity: 'critical',
          estimatedImpact: 'Misconfigured security can expose device to attacks',
          recommendedNextSteps: [
            'Verify TLS/SSL certificate validity',
            'Check authentication mechanism strength',
            'Audit access control and permissions',
            'Review secret management practices'
          ],
        });
      }
      
      if (intent === 'optimization') {
        suggestions.push({
          id: 'configuration-optimization',
          action: 'Optimize device settings',
          description: `Review and optimize configuration for ${deviceName}`,
          severity: 'info',
          estimatedImpact: 'Optimized settings reduce resource consumption and improve reliability',
          recommendedNextSteps: [
            'Review timeout and retry settings',
            'Optimize batch sizes and intervals',
            'Tune resource limits and allocations',
            'Enable recommended optimizations'
          ],
        });
      }
      
      if (intent === 'configuration-review') {
        suggestions.push({
          id: 'config-best-practices',
          action: 'Review configuration best practices',
          description: `Compare ${deviceName} configuration against industry best practices`,
          severity: 'info',
          estimatedImpact: 'Following best practices reduces incidents and improves maintainability',
          recommendedNextSteps: [
            'Check alignment with documentation',
            'Review recent configuration changes',
            'Validate required settings are present',
            'Test configuration in staging if possible'
          ],
        });
      }
      break;
  }
  
  // Always add general investigation step
  if (suggestions.length === 0) {
    suggestions.push({
      id: 'general-investigation',
      action: 'Investigate device status',
      description: `General health check and investigation for ${deviceName}`,
      severity: 'info',
      estimatedImpact: 'Helps understand overall device status and identify issues',
      recommendedNextSteps: [
        'Check recent changes or deployments',
        'Review correlations across metrics, logs, and endpoints',
        'Compare against baseline and normal patterns'
      ],
    });
  }
  
  return suggestions;
}

/**
 * Build contextual summary for device suggestions
 */
function buildDeviceAssistantSummary(
  suggestions: DeviceSuggestion[],
  deviceName: string,
  view: string,
): string {
  const viewLabel = view.charAt(0).toUpperCase() + view.slice(1);
  
  if (suggestions.length === 0) {
    return `I've analyzed ${deviceName}'s ${viewLabel} and didn't find any immediate issues. The device appears to be running normally.`;
  }
  
  const criticalCount = suggestions.filter(s => s.severity === 'critical').length;
  const warnings = suggestions.filter(s => s.severity === 'warning').length;
  
  let summary = `I've identified ${suggestions.length} recommendations for ${deviceName}'s ${viewLabel}.\n\n`;
  
  if (criticalCount > 0) {
    summary += `**Critical Issues (${criticalCount}):** These require immediate attention.\n`;
    suggestions.filter(s => s.severity === 'critical').forEach(s => {
      summary += `- **${s.action}**: ${s.description}\n`;
    });
    summary += '\n';
  }
  
  if (warnings > 0) {
    summary += `**Warnings (${warnings}):** These should be reviewed soon.\n`;
    suggestions.filter(s => s.severity === 'warning').forEach(s => {
      summary += `- **${s.action}**: ${s.description}\n`;
    });
    summary += '\n';
  }
  
  const infos = suggestions.filter(s => s.severity === 'info');
  if (infos.length > 0) {
    summary += `**Recommendations (${infos.length}):** Suggested improvements.\n`;
    infos.slice(0, 2).forEach(s => {
      summary += `- **${s.action}**: ${s.description}\n`;
    });
  }
  
  return summary;
}

/**
 * Generate device-specific suggestions based on context and view
 */
export async function generateDeviceSuggestions(
  options: GenerateDeviceSuggestionsOptions,
): Promise<GenerateDeviceSuggestionsResult> {
  const { context, requestId = 'unknown', userId } = options;
  
  try {
    logger.info('Generating device suggestions', {
      component: 'device-suggestions',
      operation: 'generateDeviceSuggestions',
      requestId,
      deviceUuid: context.deviceUuid,
      deviceView: context.deviceView,
      userId,
    });
    
    // Analyze user intent from prompt and view
    const intent = analyzeUserIntent(context.userPrompt, context.deviceView);
    
    // Generate contextual suggestions based on view and intent
    const suggestions = generateContextualSuggestions(
      context.deviceName,
      context.deviceView,
      intent,
    );
    
    // Build assistant summary
    const analysisDetails = buildDeviceAssistantSummary(suggestions, context.deviceName, context.deviceView);
    
    // Extract recommended next steps from all suggestions
    const recommendedActions = suggestions
      .flatMap(s => s.recommendedNextSteps)
      .filter((item, index, arr) => arr.indexOf(item) === index) // Deduplicate
      .slice(0, 5); // Top 5
    
    logger.info('Device suggestions generated successfully', {
      component: 'device-suggestions',
      operation: 'generateDeviceSuggestions',
      requestId,
      suggestionCount: suggestions.length,
      intent,
    });
    
    return {
      suggestions,
      viewContext: context.deviceView,
      analysisDetails,
      recommendedActions,
    };
  } catch (error) {
    logger.error('Failed to generate device suggestions', {
      component: 'device-suggestions',
      operation: 'generateDeviceSuggestions',
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    
    // Fallback: Return generic suggestion
    return {
      suggestions: [
        {
          id: 'generic-investigation',
          action: 'General investigation',
          description: `Review ${context.deviceName}'s status in the ${context.deviceView} view`,
          severity: 'info',
          estimatedImpact: 'Provides overview of device health',
          recommendedNextSteps: ['Check metrics and logs for anomalies'],
        },
      ],
      viewContext: context.deviceView,
      analysisDetails: `I'm analyzing ${context.deviceName}'s ${context.deviceView} to provide recommendations. Please check the device metrics and logs for more details.`,
      recommendedActions: ['Review device metrics', 'Check recent logs'],
    };
  }
}

/**
 * Build formatted assistant response summary
 */
export function buildDeviceAssistantResponse(result: GenerateDeviceSuggestionsResult): string {
  return result.analysisDetails;
}
