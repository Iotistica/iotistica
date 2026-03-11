import React, { useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import type { MQTTDeviceConfig } from '@/schemas/sensor-schemas';

interface MqttConfigFormProps {
  value?: MQTTDeviceConfig;
  onChange?: (config: MQTTDeviceConfig) => void;
  onValidationChange?: (isValid: boolean) => void;
}

export const MqttConfigForm: React.FC<MqttConfigFormProps> = ({
  value,
  onChange,
  onValidationChange,
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
      pollInterval: 5000,
      connection: {
        topic: '',
        qos: 1,
        dataType: 'number',
        unit: '',
        metric: '',
        deviceId: '',
        topics: [],
        discoveryRoots: [],
        metrics: [],
        autoMetrics: false,
      },
      dataPoints: [],
    },
  });

  useEffect(() => {
    const formData = getValues();
    const topic = formData.connection?.topic?.trim();
    const name = formData.name?.trim();
    onValidationChange?.(!!(name && topic));
  }, [watch('name'), watch('connection.topic'), onValidationChange, getValues]);

  useEffect(() => {
    const subscription = watch(() => {
      const formData = getValues();
      const topic = (formData.connection?.topic || '').trim();

      const nextConfig: MQTTDeviceConfig = {
        ...formData,
        protocol: 'mqtt',
        pollInterval: formData.pollInterval || 5000,
        dataPoints: [],
        connection: {
          ...formData.connection,
          topic,
          topics: topic ? [topic] : [],
          discoveryRoots: topic ? [topic] : [],
          qos: formData.connection?.qos ?? 1,
          dataType: formData.connection?.dataType || 'number',
          unit: formData.connection?.unit?.trim() || '',
          metric: formData.connection?.metric?.trim() || '',
          deviceId: formData.connection?.deviceId?.trim() || '',
          metrics: [],
          autoMetrics: Boolean(formData.connection?.autoMetrics),
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
        <Label htmlFor="mqtt-topic">
          Topic <span className="text-red-500">*</span>
        </Label>
        <Input id="mqtt-topic" {...register('connection.topic')} placeholder="e.g., factory/line1/temperature" />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="mqtt-qos">QoS</Label>
          <Controller
            name="connection.qos"
            control={control}
            render={({ field }) => (
              <Select
                value={String(field.value ?? 1)}
                onValueChange={(v) => field.onChange(Number(v) as 0 | 1 | 2)}
              >
                <SelectTrigger id="mqtt-qos">
                  <SelectValue placeholder="Select QoS" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">0</SelectItem>
                  <SelectItem value="1">1</SelectItem>
                  <SelectItem value="2">2</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="mqtt-dataType">Value Type</Label>
          <Controller
            name="connection.dataType"
            control={control}
            render={({ field }) => (
              <Select value={field.value || 'number'} onValueChange={field.onChange}>
                <SelectTrigger id="mqtt-dataType">
                  <SelectValue placeholder="Select data type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="number">number</SelectItem>
                  <SelectItem value="boolean">boolean</SelectItem>
                  <SelectItem value="string">string</SelectItem>
                  <SelectItem value="json">json</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="mqtt-unit">Unit (optional)</Label>
          <Input id="mqtt-unit" {...register('connection.unit')} placeholder="e.g., C" />
        </div>

        <div className="space-y-2">
          <Label htmlFor="mqtt-metric">Metric (optional)</Label>
          <Input id="mqtt-metric" {...register('connection.metric')} placeholder="e.g., temperature" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="mqtt-deviceId">Device ID (optional)</Label>
          <Input id="mqtt-deviceId" {...register('connection.deviceId')} placeholder="e.g., sensor-01" />
        </div>

        <div className="space-y-2">
          <Label htmlFor="mqtt-pollInterval">Poll Interval (ms)</Label>
          <Input
            id="mqtt-pollInterval"
            type="number"
            min={100}
            step={100}
            {...register('pollInterval', { valueAsNumber: true })}
            placeholder="5000"
          />
        </div>
      </div>

      <Controller
        name="enabled"
        control={control}
        render={({ field }) => (
          <div className="flex items-center space-x-2">
            <Checkbox
              id="mqtt-enabled"
              checked={field.value}
              onCheckedChange={(checked) => field.onChange(Boolean(checked))}
            />
            <Label htmlFor="mqtt-enabled" className="font-normal cursor-pointer">
              Enabled
            </Label>
          </div>
        )}
      />

      <Controller
        name="connection.autoMetrics"
        control={control}
        render={({ field }) => (
          <div className="flex items-center space-x-2 rounded-md border border-border p-3">
            <Checkbox
              id="mqtt-autoMetrics"
              checked={Boolean(field.value)}
              onCheckedChange={(checked) => field.onChange(Boolean(checked))}
            />
            <Label htmlFor="mqtt-autoMetrics" className="font-normal cursor-pointer">
              Multi-metric payload (extract all top-level fields)
            </Label>
          </div>
        )}
      />
    </div>
  );
};
