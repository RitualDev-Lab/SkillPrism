{{/*
Expand the name of the chart.
*/}}
{{- define "skillprism-hub.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "skillprism-hub.fullname" -}}
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
Common labels
*/}}
{{- define "skillprism-hub.labels" -}}
helm.sh/chart: {{ include "skillprism-hub.name" . }}-{{ .Chart.Version | replace "+" "_" }}
{{ include "skillprism-hub.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "skillprism-hub.selectorLabels" -}}
app.kubernetes.io/name: {{ include "skillprism-hub.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
