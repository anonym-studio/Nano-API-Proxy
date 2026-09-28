// Command nano-proxy-host is the Mode B Native Messaging Host (spec §2.2). Chrome launches this
// binary with no custom arguments, so the listen port arrives as the first stdin message. HTTP
// requests are multiplexed over stdio by request id, and the process must exit the moment stdin
// hits EOF so it never becomes a zombie holding the port (spec §5 item 1).
package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// Native Messaging frames are UTF-8 JSON preceded by a 4-byte length in the host's native byte
// order. Every platform Chrome ships this host on (x86/x64/ARM) is little-endian in practice, so
// we use LittleEndian rather than trying to detect a true "native" order (spec §2.2, §5 item 8).
var frameByteOrder = binary.LittleEndian

const (
	// Host -> Chrome messages are capped at 1MB by Chrome itself; request bodies are rejected
	// well under that so the JSON-framed message (with headers) never risks exceeding it.
	maxHostToChromeMessageBytes = 1024 * 1024
	maxRequestBodyBytes         = 900 * 1024
	requestTimeout              = 2 * time.Minute
)

// inboundMessage covers every shape Chrome can send us: the initial "start" handshake, and the
// response_start/chunk/response_end/error/cancel messages that answer a "request" we sent.
type inboundMessage struct {
	Type    string            `json:"type"`
	Port    int               `json:"port,omitempty"`
	ID      string            `json:"id,omitempty"`
	Status  int               `json:"status,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Data    string            `json:"data,omitempty"`
	Message string            `json:"message,omitempty"`
}

// outboundMessage covers everything we can send Chrome: ready/error at startup, and one
// "request"/"cancel" pair per in-flight HTTP request.
type outboundMessage struct {
	Type    string            `json:"type"`
	Port    int               `json:"port,omitempty"`
	Code    string            `json:"code,omitempty"`
	ID      string            `json:"id,omitempty"`
	Method  string            `json:"method,omitempty"`
	Path    string            `json:"path,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"body,omitempty"`
	Client  string            `json:"client,omitempty"`
}

type pendingRequest struct {
	updates chan inboundMessage
}

type bridge struct {
	stdoutMu sync.Mutex
	stdout   *bufio.Writer

	mu      sync.Mutex
	pending map[string]*pendingRequest

	nextID int64
}

func newBridge() *bridge {
	return &bridge{stdout: bufio.NewWriter(os.Stdout), pending: make(map[string]*pendingRequest)}
}

func (b *bridge) writeMessage(msg outboundMessage) error {
	payload, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	if len(payload) > maxHostToChromeMessageBytes {
		return fmt.Errorf("outbound message too large: %d bytes", len(payload))
	}

	b.stdoutMu.Lock()
	defer b.stdoutMu.Unlock()

	var lenBuf [4]byte
	frameByteOrder.PutUint32(lenBuf[:], uint32(len(payload)))
	if _, err := b.stdout.Write(lenBuf[:]); err != nil {
		return err
	}
	if _, err := b.stdout.Write(payload); err != nil {
		return err
	}
	return b.stdout.Flush()
}

func readMessage(r *bufio.Reader) (*inboundMessage, error) {
	var lenBuf [4]byte
	if _, err := io.ReadFull(r, lenBuf[:]); err != nil {
		return nil, err
	}
	length := frameByteOrder.Uint32(lenBuf[:])
	if length == 0 {
		return &inboundMessage{}, nil
	}
	buf := make([]byte, length)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	var msg inboundMessage
	if err := json.Unmarshal(buf, &msg); err != nil {
		return nil, err
	}
	return &msg, nil
}

func (b *bridge) register(id string) *pendingRequest {
	p := &pendingRequest{updates: make(chan inboundMessage, 32)}
	b.mu.Lock()
	b.pending[id] = p
	b.mu.Unlock()
	return p
}

func (b *bridge) unregister(id string) {
	b.mu.Lock()
	delete(b.pending, id)
	b.mu.Unlock()
}

func (b *bridge) dispatch(id string, msg inboundMessage) {
	b.mu.Lock()
	p, ok := b.pending[id]
	b.mu.Unlock()
	if !ok {
		return
	}
	select {
	case p.updates <- msg:
	default:
		// Slow consumer; drop rather than block the single stdin reader goroutine.
	}
}

func (b *bridge) newRequestID() string {
	n := atomic.AddInt64(&b.nextID, 1)
	return fmt.Sprintf("ext-%d-%d", time.Now().UnixNano(), n)
}

func isAllowedHost(host string, port int) bool {
	// Guards against DNS rebinding: only requests addressed to this exact loopback port are
	// served (spec §3.4).
	candidates := []string{
		fmt.Sprintf("127.0.0.1:%d", port),
		fmt.Sprintf("localhost:%d", port),
	}
	for _, c := range candidates {
		if host == c {
			return true
		}
	}
	return false
}

// corsOrigin implements the allowlist from spec §3.4: only localhost/127.0.0.1 origins (any
// port) are ever echoed back; there is no wildcard "*" fallback.
func corsOrigin(origin string) string {
	if strings.HasPrefix(origin, "http://localhost:") || origin == "http://localhost" ||
		strings.HasPrefix(origin, "http://127.0.0.1:") || origin == "http://127.0.0.1" {
		return origin
	}
	return ""
}

func writeJSONError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	body, _ := json.Marshal(map[string]any{"error": map[string]string{"message": message}})
	w.Write(body)
}

func (b *bridge) httpHandler(port int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !isAllowedHost(r.Host, port) {
			writeJSONError(w, http.StatusForbidden, "invalid Host header")
			return
		}

		if origin := corsOrigin(r.Header.Get("Origin")); origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		limited := io.LimitReader(r.Body, maxRequestBodyBytes+1)
		body, err := io.ReadAll(limited)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "failed to read request body")
			return
		}
		if len(body) > maxRequestBodyBytes {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "request body exceeds the 900KB local bridge limit")
			return
		}

		headers := make(map[string]string, len(r.Header))
		for key := range r.Header {
			headers[key] = r.Header.Get(key)
		}

		id := b.newRequestID()
		pending := b.register(id)
		defer b.unregister(id)

		if err := b.writeMessage(outboundMessage{
			Type:    "request",
			ID:      id,
			Method:  r.Method,
			Path:    r.URL.Path,
			Headers: headers,
			Body:    string(body),
			Client:  r.RemoteAddr,
		}); err != nil {
			writeJSONError(w, http.StatusBadGateway, "failed to reach the extension")
			return
		}

		b.pipeResponse(w, r.Context(), id, pending)
	}
}

// pipeResponse streams response_start/chunk/response_end/error messages from the extension
// straight through to the HTTP client, matching the same three-message protocol used for Mode A
// in background/service-worker.js.
func (b *bridge) pipeResponse(w http.ResponseWriter, ctx context.Context, id string, pending *pendingRequest) {
	statusSent := false
	flusher, _ := w.(http.Flusher)
	timeout := time.NewTimer(requestTimeout)
	defer timeout.Stop()

	for {
		select {
		case <-ctx.Done():
			b.writeMessage(outboundMessage{Type: "cancel", ID: id})
			return
		case <-timeout.C:
			if !statusSent {
				writeJSONError(w, http.StatusGatewayTimeout, "inference timed out")
			}
			b.writeMessage(outboundMessage{Type: "cancel", ID: id})
			return
		case msg, ok := <-pending.updates:
			if !ok {
				return
			}
			switch msg.Type {
			case "response_start":
				for k, v := range msg.Headers {
					w.Header().Set(k, v)
				}
				status := msg.Status
				if status == 0 {
					status = http.StatusOK
				}
				w.WriteHeader(status)
				statusSent = true
			case "chunk":
				if !statusSent {
					w.WriteHeader(http.StatusOK)
					statusSent = true
				}
				io.WriteString(w, msg.Data)
				if flusher != nil {
					flusher.Flush()
				}
			case "response_end":
				return
			case "error":
				if !statusSent {
					writeJSONError(w, http.StatusInternalServerError, msg.Message)
				}
				return
			}
		}
	}
}

func main() {
	logPath := flag.String("log", "", "optional path to a log file (stderr is used otherwise)")
	flag.Parse()

	// stdout is reserved for the Native Messaging protocol; every diagnostic goes to stderr (or
	// -log) instead (spec §2.2 "stdoutの扱い").
	if *logPath != "" {
		if f, err := os.OpenFile(*logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); err == nil {
			log.SetOutput(f)
			defer f.Close()
		}
	}
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)

	reader := bufio.NewReaderSize(os.Stdin, 64*1024)
	b := newBridge()

	first, err := readMessage(reader)
	if err != nil {
		log.Printf("failed to read start message: %v", err)
		os.Exit(1)
	}
	if first.Type != "start" || first.Port == 0 {
		log.Printf("unexpected first message: %+v", first)
		os.Exit(1)
	}
	port := first.Port

	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		code := "LISTEN_FAILED"
		if errors.Is(err, syscall.EADDRINUSE) {
			code = "EADDRINUSE"
		}
		log.Printf("listen on port %d failed: %v", port, err)
		b.writeMessage(outboundMessage{Type: "error", Code: code, Port: port})
		os.Exit(1)
	}

	httpServer := &http.Server{Handler: b.httpHandler(port)}
	go func() {
		if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("http server error: %v", err)
		}
	}()

	if err := b.writeMessage(outboundMessage{Type: "ready", Port: port}); err != nil {
		log.Printf("failed to write ready message: %v", err)
	}

	// Read loop: dispatches inbound messages to their pending HTTP request, and shuts down the
	// moment Chrome closes stdin (spec §5 item 1 — the required zombie-process guard).
	for {
		msg, err := readMessage(reader)
		if err != nil {
			if errors.Is(err, io.EOF) {
				log.Printf("stdin closed; shutting down")
			} else {
				log.Printf("stdin read error: %v", err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			httpServer.Shutdown(ctx)
			cancel()
			os.Exit(0)
		}
		if msg.ID != "" {
			b.dispatch(msg.ID, *msg)
		}
	}
}
