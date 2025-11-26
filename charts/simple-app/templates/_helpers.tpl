{{- define "simple-app.name" -}}
simple-app
{{- end -}}

{{- define "simple-app.fullname" -}}
{{ include "simple-app.name" . }}
{{- end -}}