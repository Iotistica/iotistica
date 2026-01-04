{{/*
Expand the name of the chart.
*/}}
{{- define "iotistic.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "iotistic.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "iotistic.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "iotistic.labels" -}}
helm.sh/chart: {{ include "iotistic.chart" . }}
{{ include "iotistic.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "iotistic.selectorLabels" -}}
app.kubernetes.io/name: {{ include "iotistic.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
PostgreSQL connection string
*/}}
{{- define "iotistic.postgres.connectionString" -}}
postgresql://{{ .Values.postgres.username }}:{{ .Values.postgres.password }}@{{ include "iotistic.fullname" . }}-postgres:{{ .Values.postgres.port }}/{{ .Values.postgres.database }}
{{- end }}

{{/*
Redis connection string
*/}}
{{- define "iotistic.redis.host" -}}
{{ include "iotistic.fullname" . }}-redis
{{- end }}

{{/*
Mosquitto MQTT broker URL
*/}}
{{- define "iotistic.mosquitto.url" -}}
mqtt://{{ include "iotistic.fullname" . }}-mosquitto:{{ .Values.mosquitto.ports.mqtt }}
{{- end }}

{{/*
Mosquitto host
*/}}
{{- define "iotistic.mosquitto.host" -}}
{{ include "iotistic.fullname" . }}-mosquitto
{{- end }}
