/**
 * OPC-UA Configuration Form
 * 
 * React Hook Form component for configuring OPC-UA devices.
 * Provides validated input fields with real-time error feedback.
 */

import React, { useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
import type { OPCUADeviceConfig } from '@/schemas/sensor-schemas';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';

interface OPCUAConfigFormProps {
  value?: OPCUADeviceConfig;
  onChange?: (config: OPCUADeviceConfig) => void;
  onValidationChange?: (isValid: boolean) => void;
  certificateMetadata?: Record<string, unknown>;
  workflowHint?: string;
}

export const OPCUAConfigForm: React.FC<OPCUAConfigFormProps> = ({
  value,
  onChange,
  onValidationChange,
  certificateMetadata,
  workflowHint,
}) => {
  const {
    register,
    control,
    watch,
    formState: { errors },
    getValues,
    reset,
    setValue,
  } = useForm<OPCUADeviceConfig>({
    mode: 'onChange',
    defaultValues: value || {
      name: '',
      protocol: 'opcua',
      enabled: true,
      pollInterval: 1000,
      connection: {
        endpointUrl: 'opc.tcp://10.0.0.60:4840',
        securityMode: 'None',
        securityPolicy: 'None',
        certificateTrustMode: 'strict',
        connectionTimeout: 10000,
        sessionTimeout: 60000,
        keepAliveInterval: 5000,
        useSubscription: false,
        publishingInterval: 1000,
        samplingInterval: 500,
        maxMonitoredItemsPerSubscription: 100,
      },
      dataPoints: [],
    },
  });

  // Reset form when value prop changes (e.g., when editing existing device)
  useEffect(() => {
    if (value) {
      reset(value);
    }
  }, [value, reset]);

  // Notify parent of validation state changes
  useEffect(() => {
    const formData = getValues();
    const isValid = !!(formData.name && formData.name.trim() !== '' && 
                       formData.connection?.endpointUrl && formData.connection.endpointUrl.trim() !== '');
    onValidationChange?.(isValid);
  }, [watch('name'), watch('connection'), onValidationChange, getValues]);

  // Notify parent of form value changes
  useEffect(() => {
    const handleChange = () => {
      const formData = getValues();
      onChange?.(formData as OPCUADeviceConfig);
    };
    
    const subscription = watch(handleChange);
    return () => {
      if (subscription && 'unsubscribe' in subscription) {
        (subscription as any).unsubscribe();
      }
    };
  }, [watch, onChange, getValues]);

  const securityMode = watch('connection.securityMode');
  const certificateTrustMode = watch('connection.certificateTrustMode');
  const expectedServerThumbprint = watch('connection.expectedServerThumbprint');

  const normalizeThumbprint = (thumbprint?: string) =>
    thumbprint?.replace(/[^a-fA-F0-9]/g, '').toLowerCase() || '';

  const discoveredThumbprint = normalizeThumbprint(
    typeof certificateMetadata?.serverCertificateThumbprint === 'string'
      ? certificateMetadata.serverCertificateThumbprint
      : undefined
  );
  const approvedThumbprint = normalizeThumbprint(expectedServerThumbprint);
  const selectedSecurityMode = typeof certificateMetadata?.selectedSecurityMode === 'string'
    ? certificateMetadata.selectedSecurityMode
    : undefined;
  const selectedSecurityPolicy = typeof certificateMetadata?.selectedSecurityPolicy === 'string'
    ? certificateMetadata.selectedSecurityPolicy
    : undefined;
  const certificateStatus = !approvedThumbprint
    ? 'unpinned'
    : approvedThumbprint === discoveredThumbprint && discoveredThumbprint
      ? 'matched'
      : discoveredThumbprint && approvedThumbprint !== discoveredThumbprint
        ? 'mismatch'
        : 'pinned';

  const applyStrictThumbprint = (thumbprint: string) => {
    setValue('connection.certificateTrustMode', 'strict', { shouldDirty: true, shouldValidate: true });
    setValue('connection.expectedServerThumbprint', thumbprint, { shouldDirty: true, shouldValidate: true });
  };

  const clearThumbprint = () => {
    setValue('connection.expectedServerThumbprint', undefined, { shouldDirty: true, shouldValidate: true });
  };

  const setTrustOnFirstUse = () => {
    setValue('connection.certificateTrustMode', 'trust-on-first-use', { shouldDirty: true, shouldValidate: true });
    setValue('connection.expectedServerThumbprint', undefined, { shouldDirty: true, shouldValidate: true });
  };

  return (
    <div className="space-y-6">
      {/* Device Name */}
      <div className="space-y-2">
        <Label htmlFor="opcua-name">
          Device Name <span className="text-red-500">*</span>
        </Label>
        <Input
          id="opcua-name"
          {...register('name', { required: 'Name is required' })}
          placeholder="e.g., temperature_controller_1"
        />
        {errors.name && (
          <p className="text-sm text-red-500">{errors.name.message}</p>
        )}
        <p className="text-xs text-muted-foreground">
          Unique identifier (letters, numbers, hyphens, underscores only)
        </p>
      </div>

      {/* Connection Settings */}
      <div className="space-y-4 p-4 border border-border rounded-lg">
        <h3 className="text-sm font-semibold">Connection Settings</h3>

        {/* Endpoint URL */}
        <div className="space-y-2">
          <Label htmlFor="endpointUrl">
            Endpoint URL <span className="text-red-500">*</span>
          </Label>
          <Input
            id="endpointUrl"
            {...register('connection.endpointUrl', { required: 'Endpoint URL is required' })}
            placeholder="opc.tcp://10.0.0.60:4840"
          />
          {errors.connection?.endpointUrl && (
            <p className="text-sm text-red-500">{errors.connection.endpointUrl.message}</p>
          )}
          <p className="text-xs text-muted-foreground">
            OPC-UA server endpoint (e.g., opc.tcp://hostname:4840)
          </p>
        </div>

        {/* Security Settings */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="securityMode">Security Mode</Label>
            <Controller
              name="connection.securityMode"
              control={control}
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="securityMode">
                    <SelectValue placeholder="Select security mode" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="None">None</SelectItem>
                    <SelectItem value="Sign">Sign</SelectItem>
                    <SelectItem value="SignAndEncrypt">Sign & Encrypt</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="securityPolicy">Security Policy</Label>
            <Controller
              name="connection.securityPolicy"
              control={control}
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="securityPolicy">
                    <SelectValue placeholder="Select security policy" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="None">None</SelectItem>
                    <SelectItem value="Basic128Rsa15">Basic128Rsa15</SelectItem>
                    <SelectItem value="Basic256">Basic256</SelectItem>
                    <SelectItem value="Basic256Sha256">Basic256Sha256</SelectItem>
                    <SelectItem value="Aes128_Sha256_RsaOaep">Aes128_Sha256_RsaOaep</SelectItem>
                    <SelectItem value="Aes256_Sha256_RsaPss">Aes256_Sha256_RsaPss</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="certificateTrustMode">Certificate Trust</Label>
            <Controller
              name="connection.certificateTrustMode"
              control={control}
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="certificateTrustMode">
                    <SelectValue placeholder="Select certificate trust mode" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="strict">Strict</SelectItem>
                    <SelectItem value="trust-on-first-use">Trust On First Use</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
            <p className="text-xs text-muted-foreground">
              Strict rejects unknown server certificates. Trust On First Use auto-enrolls the first certificate presented by the server.
            </p>
          </div>
        </div>

        <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
          <div className="space-y-1">
            <h4 className="text-sm font-semibold">Certificate Workflow</h4>
            <p className="text-xs text-muted-foreground">
              Approve or rotate the server certificate without editing the raw connection JSON.
            </p>
            {workflowHint && (
              <p className="text-xs text-muted-foreground">{workflowHint}</p>
            )}
          </div>

          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
            <div className="space-y-1">
              <Label>Approved Certificate</Label>
              <p className="break-all font-mono text-xs text-muted-foreground">
                {approvedThumbprint || 'No certificate pin configured'}
              </p>
            </div>
            <div className="space-y-1">
              <Label>Discovered Certificate</Label>
              <p className="break-all font-mono text-xs text-muted-foreground">
                {discoveredThumbprint || 'No discovered certificate metadata yet'}
              </p>
            </div>
          </div>

          {(selectedSecurityMode || selectedSecurityPolicy) && (
            <p className="text-xs text-muted-foreground">
              Discovered endpoint security:
              {` ${selectedSecurityMode || 'Unknown mode'} / ${selectedSecurityPolicy || 'Unknown policy'}`}
            </p>
          )}

          {certificateStatus === 'mismatch' && (
            <Alert>
              <AlertDescription>
                The discovered OPC UA certificate differs from the currently approved pin. Use Rotate to approve the new certificate before deploying.
              </AlertDescription>
            </Alert>
          )}

          {certificateStatus === 'matched' && (
            <Alert>
              <AlertDescription>
                The currently approved certificate matches the latest discovered certificate metadata.
              </AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap gap-2">
            {discoveredThumbprint && approvedThumbprint !== discoveredThumbprint && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => applyStrictThumbprint(discoveredThumbprint)}
              >
                {approvedThumbprint ? 'Rotate To Discovered Certificate' : 'Approve Discovered Certificate'}
              </Button>
            )}
            {certificateTrustMode !== 'trust-on-first-use' && (
              <Button
                type="button"
                variant="outline"
                onClick={setTrustOnFirstUse}
              >
                Switch To Trust On First Use
              </Button>
            )}
            {certificateTrustMode !== 'strict' && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setValue('connection.certificateTrustMode', 'strict', { shouldDirty: true, shouldValidate: true })}
              >
                Enforce Strict Trust
              </Button>
            )}
            {approvedThumbprint && (
              <Button
                type="button"
                variant="ghost"
                onClick={clearThumbprint}
              >
                Clear Certificate Pin
              </Button>
            )}
          </div>
        </div>

        {/* Credentials (if security enabled) */}
        {securityMode !== 'None' && (
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                {...register('connection.username')}
                placeholder="Optional"
                autoComplete="username"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                {...register('connection.password')}
                placeholder="Optional"
                autoComplete="current-password"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="expectedServerThumbprint">Expected Server Thumbprint</Label>
              <Input
                id="expectedServerThumbprint"
                {...register('connection.expectedServerThumbprint')}
                placeholder="40-char SHA-1 thumbprint"
                autoCapitalize="none"
                autoCorrect="off"
              />
              <p className="text-xs text-muted-foreground">
                Optional certificate pin. Recommended with Strict trust mode for fixed PLC or gateway endpoints.
              </p>
              {certificateTrustMode === 'trust-on-first-use' && (
                <p className="text-xs text-muted-foreground">
                  When Trust On First Use is enabled, the first unknown certificate will be trusted and stored locally.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Timeout Settings */}
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="space-y-2">
            <Label htmlFor="connectionTimeout">Connection Timeout (ms)</Label>
            <Input
              id="connectionTimeout"
              type="number"
              {...register('connection.connectionTimeout', { valueAsNumber: true })}
              placeholder="10000"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="sessionTimeout">Session Timeout (ms)</Label>
            <Input
              id="sessionTimeout"
              type="number"
              {...register('connection.sessionTimeout', { valueAsNumber: true })}
              placeholder="60000"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="keepAliveInterval">Keep Alive (ms)</Label>
            <Input
              id="keepAliveInterval"
              type="number"
              {...register('connection.keepAliveInterval', { valueAsNumber: true })}
              placeholder="5000"
            />
          </div>
        </div>
      </div>

      <div className="space-y-4 p-4 border border-border rounded-lg">
        <Controller
          name="connection.useSubscription"
          control={control}
          render={({ field }) => (
            <div className="flex items-center" style={{ columnGap: '12px' }}>
              <Checkbox
                id="useSubscription"
                checked={field.value}
                onCheckedChange={field.onChange}
              />
              <Label htmlFor="useSubscription" className="font-normal cursor-pointer">
                Use Subscription
              </Label>
            </div>
          )}
        />

        {watch('connection.useSubscription') && (
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div className="space-y-2">
              <Label htmlFor="publishingInterval">Publishing Interval (ms)</Label>
              <Input
                id="publishingInterval"
                type="number"
                {...register('connection.publishingInterval', { valueAsNumber: true })}
                placeholder="1000"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="samplingInterval">Sampling Interval (ms)</Label>
              <Input
                id="samplingInterval"
                type="number"
                {...register('connection.samplingInterval', { valueAsNumber: true })}
                placeholder="500"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="maxMonitoredItems">Max Monitored Items</Label>
              <Input
                id="maxMonitoredItems"
                type="number"
                {...register('connection.maxMonitoredItemsPerSubscription', { valueAsNumber: true })}
                placeholder="100"
              />
            </div>
          </div>
        )}
      </div>

      {/* Common Settings */}
      <div className="space-y-4 p-4 border border-border rounded-lg">
        <h3 className="text-sm font-semibold">Common Settings</h3>

        <div className="space-y-2" style={{ maxWidth: '180px' }}>
          <Label htmlFor="opcua-pollInterval">Poll Interval (ms)</Label>
          <Input
            id="opcua-pollInterval"
            type="number"
            {...register('pollInterval', { valueAsNumber: true })}
            placeholder="1000"
          />
          <p className="text-xs text-muted-foreground">
            How often to read node values (100-30000ms)
          </p>
        </div>
      </div>

      <div
        className="flex items-center"
        style={{ columnGap: '12px', paddingTop: '10px', paddingBottom: '20px' }}
      >
        <Controller
          name="enabled"
          control={control}
          render={({ field }) => (
            <>
              <Checkbox
                id="opcua-enabled"
                checked={field.value}
                onCheckedChange={field.onChange}
              />
              <Label htmlFor="opcua-enabled" className="font-normal cursor-pointer">
                Enabled
              </Label>
            </>
          )}
        />
      </div>
    </div>
  );
};
