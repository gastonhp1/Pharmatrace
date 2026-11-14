{{- define "pt.labels" -}}
app.kubernetes.io/part-of: pharmatrace
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{/* The two Secrets of a node, as the directories Fabric expects: msp/{signcerts,keystore,cacerts} and tls/. */}}
{{- define "pt.identityVolumes" -}}
- name: msp
  secret:
    secretName: {{ . }}-msp
    defaultMode: 0440
    items:
      - { key: cert.pem, path: signcerts/cert.pem }
      - { key: key.pem, path: keystore/key.pem }
      - { key: ca.pem, path: cacerts/ca.pem }
      - { key: config.yaml, path: config.yaml }
- name: tls
  secret:
    secretName: {{ . }}-tls
    defaultMode: 0440
{{- end }}

{{- define "pt.volumeClaim" -}}
volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: [ReadWriteOnce]
      {{- with .root.Values.storage.className }}
      storageClassName: {{ . }}
      {{- end }}
      resources:
        requests:
          storage: {{ .size }}
{{- end }}
