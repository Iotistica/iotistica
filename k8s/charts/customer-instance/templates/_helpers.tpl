{{/*
Expand the name of the chart.
*/}}
{{- define "customer-instance.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "customer-instance.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- /* prefer a short sanitized customer id when available to avoid long names */ -}}
{{- $short := .Values.customer.shortId }}
{{- if $short }}
{{- /* prepend 'c' to ensure it starts with a letter (DNS-1035 compliance) */ -}}
{{- /* Use printf with %s to force string treatment, preventing scientific notation */ -}}
{{- printf "c%s-%s" (printf "%s" $short) $name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}
{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "customer-instance.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "customer-instance.labels" -}}
helm.sh/chart: {{ include "customer-instance.chart" . }}
{{ include "customer-instance.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
customer-id: {{ .Values.customer.id | quote }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "customer-instance.selectorLabels" -}}
app.kubernetes.io/name: {{ include "customer-instance.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Generate postgres password
*/}}
{{- define "customer-instance.postgresPassword" -}}
{{- if .Values.postgres.password }}
{{- .Values.postgres.password }}
{{- else }}
{{- $secret := lookup "v1" "Secret" .Release.Namespace (printf "%s-secrets" (include "customer-instance.fullname" .)) }}
{{- if $secret }}
{{- index $secret.data "POSTGRES_PASSWORD" | b64dec }}
{{- else }}
{{- randAlphaNum 32 }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Generate MQTT password
*/}}
{{- define "customer-instance.mqttPassword" -}}
{{- if .Values.mosquitto.credentials.password }}
{{- .Values.mosquitto.credentials.password }}
{{- else }}
{{- $secret := lookup "v1" "Secret" .Release.Namespace (printf "%s-secrets" (include "customer-instance.fullname" .)) }}
{{- if $secret }}
{{- index $secret.data "MQTT_PASSWORD" | b64dec }}
{{- else }}
{{- randAlphaNum 32 }}
{{- end }}
{{- end }}
{{- end }}
