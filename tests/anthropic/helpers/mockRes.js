/**
 * Minimal mock of node:http.ServerResponse for unit tests.
 * Captures statusCode, headers, and body writes.
 */
export function createMockRes() {
    const res = {
        statusCode: 200,
        headers: {},
        body: '',
        writableEnded: false,
        writeHead(code, headers) {
            this.statusCode = code;
            this.headers = { ...this.headers, ...headers };
        },
        setHeader(name, value) {
            this.headers[name] = value;
        },
        write(chunk) {
            if (this.writableEnded) return;
            this.body += chunk;
            return true;
        },
        end(chunk) {
            if (chunk) this.body += chunk;
            this.writableEnded = true;
        },
    };
    return res;
}