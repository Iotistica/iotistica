import React, { useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import type { MQTTDeviceConfig } from '@/schemas/sensor-schemas';

interface MqttConfigFormProps {
  value?: MQTTDeviceConfig;
  onChange?: (config: MQTTDeviceConfig) => void;
  onValidationChange?: (isValid: boolean) => void;
  readOnlyTopic?: string;
}

export const MqttConfigForm: React.FC<MqttConfigFormProps> = ({
  value,
  onChange,
  onValidationChange,
  readOnlyTopic,
}) => {
  const {
    register,
    control,
    watch,
    getValues,
  } = useForm<MQTTDeviceConfig>({
    mode: 'onChange',
    defaultValues: value || {
      name: '',
      protocol: 'mqtt',
      enabled: true,
      connection: {
        qos: 1,
      },
    },
  });

  useEffect(() => {
    const formData = getValues();
    const name = formData.name?.trim();
    onValidationChange?.(!!name);
  }, [watch('name'), onValidationChange, getValues]);

  useEffect(() => {
    const subscription = watch(() => {
      const formData = getValues();

      const nextConfig: MQTTDeviceConfig = {
        ...formData,
        protocol: 'mqtt',
        connection: {
          ...(formData.connection || {}),
          qos: formData.connection?.qos ?? 1,
        },
      };

      onChange?.(nextConfig);
    });

    return () => {
      if (subscription && 'unsubscribe' in subscription) {
        (subscription as any).unsubscribe();
      }
    };
  }, [watch, onChange, getValues]);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="mqtt-name">
          Device Name <span className="text-red-500">*</span>
        </Label>
        <Input id="mqtt-name" {...register('name')} placeholder="e.g., boiler_temp_sensor" />
      </div>

      <div className="space-y-2">
        <Label>Topic</Label>
        {readOnlyTopic ? (
          <p className="font-mono text-sm bg-muted px-3 py-2 rounded-md break-all">{readOnlyTopic}</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Generated automatically as <span className="font-mono">i/&lt;tenantId&gt;/a/&lt;agentUuid&gt;/d/&lt;endpointUuid&gt;</span> when the device is added.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="mqtt-qos">QoS</Label>
        <Controller
          name="connection.qos"
          control={control}
          render={({ field }) => (
            <Input
              id="mqtt-qos"
              type="number"
              min={0}
              max={2}
              step={1}
              value={field.value ?? 1}
              onChange={(e) => {
                const n = Number(e.target.value);
                field.onChange(Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : 1);
              }}
              style={{ maxWidth: '90px' }}
            />
          )}
        />
      </div>

    </div>
  );
};
