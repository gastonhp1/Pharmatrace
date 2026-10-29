package contract

import "fmt"

// Errors the client can act on start with a code, so an API in front of the chaincode can map
// them to HTTP statuses without parsing the text: "NOT_FOUND: batch B1 does not exist".
// Errors without a code are unexpected (the ledger failed, corrupt data) and map to 500.
const (
	CodeNotFound  = "NOT_FOUND"
	CodeForbidden = "FORBIDDEN"
	CodeConflict  = "CONFLICT"
	CodeInvalid   = "INVALID"
)

func coded(code, format string, args ...any) error {
	return fmt.Errorf(code+": "+format, args...)
}

func notFound(format string, args ...any) error  { return coded(CodeNotFound, format, args...) }
func forbidden(format string, args ...any) error { return coded(CodeForbidden, format, args...) }
func conflict(format string, args ...any) error  { return coded(CodeConflict, format, args...) }
func invalid(format string, args ...any) error   { return coded(CodeInvalid, format, args...) }
