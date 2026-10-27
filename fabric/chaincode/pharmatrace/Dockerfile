# PharmaTrace chaincode as a service. The peer does not build or launch this container: it
# connects to it at the address in the chaincode package (connection.json).
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/chaincode .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/chaincode /chaincode
ENV CHAINCODE_SERVER_ADDRESS=0.0.0.0:9999
EXPOSE 9999
USER nonroot:nonroot
ENTRYPOINT ["/chaincode"]
