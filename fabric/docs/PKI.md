# PKI de la red: Fabric CA y runbook de certificados

En Fabric todo es un certificado X.509: los peers, los orderers, los administradores, los usuarios y el gateway
IoT. Quién puede hacer qué sale de qué CA firmó el certificado y de qué dice adentro. Operar Fabric es, en buena
parte, operar esa PKI: emitir, renovar antes de que venza, rotar y revocar sin tirar la red.

Todo lo de este documento está en [`network/scripts/pki.sh`](../network/scripts/pki.sh) y lo prueba la CI con
[`network/scripts/pki-test.sh`](../network/scripts/pki-test.sh) contra la red levantada.

## Cómo está armada

```
 ca.orderer  ──▶  orderer0..2 (MSP + TLS), Admin@orderer
 ca.lab      ──▶  peer0.lab (MSP + TLS), Admin, User1
 ca.dist     ──▶  peer0.dist (MSP + TLS), Admin, User1, IotGateway (pharmatrace.role=iot-gateway)
 ca.farma    ──▶  peer0.farma (MSP + TLS), Admin, User1
 ca.reg      ──▶  peer0.reg (MSP + TLS), Admin, User1
```

- **Una CA por organización** (`compose.yaml`, imagen `hyperledger/fabric-ca`). Cada org controla su propia
  emisión: el regulador no puede emitir certificados de la droguería, ni al revés. Con cryptogen todas las claves
  salían de una sola máquina.
- **La CA emite identidades y TLS.** `fabric-ca-client enroll` emite el certificado de identidad (MSP), y con
  `--enrollment.profile tls --csr.hosts ...` emite el certificado TLS del nodo para esos nombres de host.
- **El tipo de identidad va en el certificado.** Al registrar una identidad con `--id.type peer|client|admin|orderer`,
  la CA pone ese tipo como OU. Con *NodeOUs* (el `config.yaml` de cada MSP), eso es lo que hace funcionar
  `LabMSP.peer` o `RegMSP.admin` en las políticas.
- **Las claves nunca salen de donde se usan.** Cada secreto de enrolamiento es aleatorio y se usa una vez, y el
  único secreto que queda guardado es el del admin bootstrap de las CAs (`organizations/fabric-ca/admin.secret`).
- **La estructura de carpetas es la misma que dejaba cryptogen**, así que ni la red, ni los scripts, ni la API
  tuvieron que cambiar de rutas.

`./network.sh up` levanta primero las CAs y después corre `pki.sh bootstrap`. Recién entonces arranca orderers y
peers, porque montan carpetas que solo existen cuando las CAs ya emitieron los certificados.

## Control de acceso por atributo (ABAC)

El gateway IoT ya no es una lista de certificados en el ledger. Es cualquier identidad cuyo certificado tenga el
atributo `pharmatrace.role=iot-gateway`, siempre que su org esté aceptada por el regulador:

```bash
fabric-ca-client register --id.name iotgateway --id.type client --id.attrs 'pharmatrace.role=iot-gateway:ecert'
```

- `:ecert` hace que el atributo vaya en el certificado de enrolamiento. La CA lo escribe en una extensión X.509 que
  solo ella puede firmar, así que una identidad no puede darse un rol a sí misma.
- El chaincode lo lee con `GetClientIdentity().GetAttributeValue("pharmatrace.role")`. Está en `clientRole`
  (`contract/helpers.go`) e `isAttestor` (`contract/coldchain.go`).
- El regulador decide qué orgs pueden tener gateways (`AuthorizeGatewayOrg` / `RevokeGatewayOrg`). La org decide
  cuáles de sus identidades lo son, con su CA.

Así, sumar o reemplazar un gateway es una operación de la CA de la org, sin ninguna transacción, y darlo de baja es
revocar su certificado. Es la separación de responsabilidades que se espera en un consorcio.

## Runbook

### Ver qué vence y cuándo

```bash
./network.sh pki status
```

Lista todos los certificados (raíces de las CAs, identidades y TLS) con los días que les quedan, los más próximos
primero. Por defecto Fabric CA emite certificados de nodos y usuarios por **1 año**, y la raíz por 15. En
producción este chequeo corre solo (un job programado o un exporter de Prometheus que lea los certificados) y
alerta a los 30 días: un certificado vencido de un peer lo deja fuera de la red.

### Renovar un peer

```bash
./network.sh pki renew-peer dist
```

1. El admin de la CA le pone al peer un secreto de un solo uso (`fabric-ca-client identity modify`).
2. Se guarda una copia de los certificados viejos en `organizations/backup/<fecha>/`.
3. Se emiten un certificado de identidad y uno TLS nuevos, **con claves nuevas**.
4. Se reinicia el peer y se espera a que responda.

Se usa un enrolamiento nuevo y no `fabric-ca-client reenroll` porque `reenroll` se autentica con el certificado
actual: **el día que venció ya no sirve**. El enrolamiento nuevo funciona con un certificado vencido o comprometido,
y además rota la clave.

No hace falta tocar el canal: el canal confía en la CA de la org, no en el certificado puntual del peer.

### Rotar el certificado TLS de un orderer

```bash
./network.sh pki rotate-orderer-tls 1
```

Es la operación más delicada de la red. En Raft los orderers se autentican entre sí por TLS, y **el canal tiene
fijado el certificado TLS de cada consenter** (`Orderer.ConsensusType.metadata.consenters`). Si el orderer arranca
con un certificado nuevo que el canal no conoce, los otros lo rechazan y queda afuera.

El orden correcto:

1. Emitir el certificado TLS nuevo.
2. Hacer un **config update del canal** que reemplaza el certificado de ese consenter: bajar la config, editarla con
   `jq`, calcular la diferencia con `configtxlator` y enviarla firmada por el **admin de la org de orderers**, que es
   la que tiene derecho a cambiar esa parte (`/Channel/Orderer/Admins`).
3. Reiniciar ese orderer, que arranca con el certificado nuevo.

Entre el paso 2 y el 3 ese orderer está aislado. Los otros dos mantienen el quórum (2 de 3), por eso se rota **de
a uno**. La CI lo comprueba: rota `orderer1`, apaga `orderer0` y manda una transacción. Solo puede ordenarse si
`orderer2` acepta el certificado nuevo de `orderer1`.

El mecanismo de `update_channel_config` en `pki.sh` sirve para cualquier cambio de configuración del canal: sumar
una org, cambiar políticas, mover endpoints.

### Sumar un gateway IoT

```bash
./network.sh pki register-gateway dist IotGateway2
```

Registra y enrola una identidad con el atributo de gateway. Funciona en el acto, sin transacciones ni cambios en el
chaincode.

### Revocar una identidad

```bash
./network.sh pki revoke dist IotGateway
```

1. La CA revoca el certificado y genera la **CRL** (`fabric-ca-client revoke --gencrl`).
2. Un config update publica esa CRL en el MSP de la org dentro del canal (`revocation_list`), firmado por el admin
   de esa org.

El paso 2 es el que se olvida: **los peers no le preguntan nada a la CA**. Validan contra el MSP que está en el
canal, así que una revocación que solo existe en la CA no tiene ningún efecto. Con la CRL en el canal, cualquier
propuesta firmada con ese certificado se rechaza.

## Qué falta para producción

- **CA raíz offline y CAs intermedias.** Hoy cada CA es raíz y está online. Lo correcto es una raíz guardada fuera
  de línea que firma intermedias, y que el MSP del canal confíe en la raíz.
- **CA de TLS separada** de la de identidades, para que comprometer una no comprometa la otra.
- **Claves en HSM** (PKCS#11, que soportan tanto Fabric CA como peers y orderers), sobre todo las de la CA y los
  admins.
- **Base de datos de la CA** en PostgreSQL con respaldo, en lugar del SQLite del volumen.
- **Renovación automática:** en Kubernetes, un `CronJob` que mire los vencimientos y renueve, o cert-manager con
  un issuer de Fabric CA. Es lo que sigue en el paso de Kubernetes.
