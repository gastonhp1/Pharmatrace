# La red en Kubernetes

La misma red que en Docker Compose (5 Fabric CAs, 3 orderers Raft, un peer por org y el chaincode como servicio),
desplegada con un chart de Helm propio: [`fabric/helm/pharmatrace-network`](../helm/pharmatrace-network). En la CI
corre en **kind** dentro de GitHub Actions, con las mismas pruebas que en Docker: el smoke test, el recorrido de la
API con las valijas simuladas y el runbook de certificados.

## Correrlo

Necesitás lo mismo que para Docker (`./network.sh prereq`) más `kind`, `kubectl` y `helm`.

```bash
cd fabric/network
./k8s.sh all            # cluster kind + CAs + identidades + nodos + canal + chaincode + smoke test
./k8s.sh api            # el recorrido por HTTP, con la API corriendo en tu máquina
./k8s.sh pki-test       # el runbook de certificados, contra el cluster
kubectl -n pharmatrace get pods
./k8s.sh down --cluster # borra todo, cluster incluido
```

## Cómo está armado

```
 namespace pharmatrace
 ├── ca-orderer, ca-lab, ca-dist, ca-farma, ca-reg     StatefulSet + PVC (base de la CA y su clave raíz)
 ├── orderer0, orderer1, orderer2                      StatefulSet + PVC (ledger) + Secrets <nodo>-msp/-tls
 ├── peer0-lab, peer0-dist, peer0-farma, peer0-reg     StatefulSet + PVC (ledger) + Secrets <nodo>-msp/-tls
 └── cc-peer0lab, cc-peer0dist, ...                    Deployment del chaincode, uno por org
```

- **StatefulSets con volumen propio** para todo lo que tiene estado: el ledger de cada peer y orderer, y la base
  de cada CA. Un pod que se reinicia vuelve con sus datos y con el mismo nombre de red.
- **Las identidades son Secrets.** Cada nodo tiene dos: `<nodo>-msp` (certificado, clave, CA y `config.yaml` de
  NodeOUs) y `<nodo>-tls`. El chart no tiene ninguna clave en sus values: las monta desde los Secrets.
- **El chaincode corre como servicio**, un Deployment por org (`cc-<peer>`), sin root, con el sistema de archivos
  de solo lectura y sin capabilities. El peer no necesita acceso a Docker ni a la API de Kubernetes para lanzarlo.
- **Nombres de red del cluster:** dentro del namespace los nodos se llaman por su Service (`orderer0:7050`,
  `peer0-lab:7051`). El perfil del canal se genera con esos nombres a partir del mismo `configtx.yaml`
  (`k8s_configtx` en `k8s.sh`).

## Instalación en dos fases

Los orderers y peers montan Secrets que solo existen cuando las CAs ya emitieron los certificados. Por eso
`k8s.sh up` instala el chart dos veces:

1. `nodes.enabled=false`: levanta solo las CAs.
2. Con port-forwards a las CAs, corre `scripts/pki.sh bootstrap`, el mismo de Docker, y guarda cada identidad
   como Secret (`node_sync_certs` en `scripts/runtime.sh`).
3. `nodes.enabled=true`: levanta orderers y peers.

Los certificados TLS se emiten con todos los nombres de cada nodo: el de Docker (`peer0.lab.pharmatrace.ar`), el
del Service (`peer0-lab`, `peer0-lab.pharmatrace.svc.cluster.local`) y `localhost`. Así los mismos certificados
sirven en los dos entornos.

## Port-forwards: los mismos scripts en los dos entornos

`k8s.sh` hace port-forward de cada nodo **al mismo puerto local que publica Docker**: `peer0-dist` en el 8051,
`orderer1` en el 8050 y el 8053, `ca-reg` en el 10054. Así `network.sh channel`, `network.sh deploy`, el smoke test,
la API y el runbook de PKI corren sin cambios contra el cluster. Lo único que cambia según el entorno es cómo se
arranca, se para o se reinicia un nodo, y cómo recibe sus certificados (`scripts/runtime.sh`, con `RUNTIME=k8s`).

Cada port-forward corre en un loop: cuando el pod se reinicia (una renovación de certificados, un orderer parado
a propósito) `kubectl port-forward` se corta y el loop lo vuelve a levantar.

## Renovar y rotar certificados en Kubernetes

El runbook es el mismo ([PKI.md](PKI.md)) y la CI lo prueba también acá. La diferencia está en el último paso:
después de emitir el certificado nuevo, se actualizan los Secrets del nodo y se borra el pod, y el StatefulSet lo
recrea con las identidades nuevas. Para el orderer sigue valiendo el orden de siempre: primero el config update del
canal, después el reinicio, y de a uno.

## Qué falta para AKS

kind sirve para probar todo gratis. Para un cluster real faltan estas piezas, que son el paso siguiente:

- **Registro de imágenes:** en kind la imagen del chaincode se carga directo en el nodo (`kind load`). En AKS se
  publica en GHCR o ACR, firmada, como la imagen de la API.
- **Acceso desde afuera:** hoy todo es por port-forward. Para clientes externos hace falta exponer los peers y
  orderers por gRPC con TLS passthrough (un Ingress o Gateway con SNI, o un Service LoadBalancer por nodo).
- **GitOps:** el chart pasa a ser una Application de ArgoCD en el repo de plataforma. Los Secrets de identidades no
  van al repo: se cargan desde Azure Key Vault con External Secrets o el CSI driver.
- **La API en el cluster**, al lado de los peers, con su propio Deployment y las identidades de su org.
- **Renovación automática:** un CronJob que corra `pki.sh status` y renueve antes de que venza.
- **Una org por namespace (o por cluster):** acá todas comparten namespace por simplicidad. En un consorcio real
  cada org opera su propia infraestructura.
