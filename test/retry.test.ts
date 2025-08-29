import { Client, APIErrorCode } from "../src"

describe("Retry Mechanism", () => {
  let mockFetch: jest.MockedFn<typeof fetch>
  let notion: Client

  beforeEach(() => {
    mockFetch = jest.fn()
    jest.clearAllMocks()
  })

  it("should retry on rate limit errors", async () => {
    // First call returns rate limit error, second succeeds
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              code: "rate_limited",
              message: "Rate limited",
              object: "error",
              status: 429,
            })
          ),
        headers: new Headers(),
        status: 429,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ success: true })),
        headers: new Headers(),
        status: 200,
      } as Response)

    notion = new Client({
      fetch: mockFetch,
      retry: {
        maxRetries: 2,
        initialDelayMs: 100, // Short delay for tests
      },
    })

    const result = await notion.request({
      path: "users",
      method: "get",
    })

    expect(result).toEqual({ success: true })
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it("should retry on server errors (5xx)", async () => {
    // First call returns server error, second succeeds
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              code: "internal_server_error",
              message: "Internal server error",
              object: "error",
              status: 500,
            })
          ),
        headers: new Headers(),
        status: 500,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ success: true })),
        headers: new Headers(),
        status: 200,
      } as Response)

    notion = new Client({
      fetch: mockFetch,
      retry: {
        maxRetries: 2,
        initialDelayMs: 100,
      },
    })

    const result = await notion.request({
      path: "users",
      method: "get",
    })

    expect(result).toEqual({ success: true })
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it("should not retry on client errors (4xx except rate limit)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            code: "unauthorized",
            message: "Unauthorized",
            object: "error",
            status: 401,
          })
        ),
      headers: new Headers(),
      status: 401,
    } as Response)

    notion = new Client({
      fetch: mockFetch,
      retry: {
        maxRetries: 2,
        initialDelayMs: 100,
      },
    })

    await expect(
      notion.request({
        path: "users",
        method: "get",
      })
    ).rejects.toThrow()

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("should respect maxRetries configuration", async () => {
    // Always return rate limit error
    mockFetch.mockResolvedValue({
      ok: false,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            code: "rate_limited",
            message: "Rate limited",
            object: "error",
            status: 429,
          })
        ),
      headers: new Headers(),
      status: 429,
    } as Response)

    notion = new Client({
      fetch: mockFetch,
      retry: {
        maxRetries: 2,
        initialDelayMs: 100,
      },
    })

    await expect(
      notion.request({
        path: "users",
        method: "get",
      })
    ).rejects.toThrow()

    // Should try initial + 2 retries = 3 total calls
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it("should allow disabling retry for rate limits", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            code: "rate_limited",
            message: "Rate limited",
            object: "error",
            status: 429,
          })
        ),
      headers: new Headers(),
      status: 429,
    } as Response)

    notion = new Client({
      fetch: mockFetch,
      retry: {
        maxRetries: 2,
        retryOnRateLimit: false,
      },
    })

    await expect(
      notion.request({
        path: "users",
        method: "get",
      })
    ).rejects.toThrow()

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("should allow disabling retry for server errors", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            code: "internal_server_error",
            message: "Internal server error",
            object: "error",
            status: 500,
          })
        ),
      headers: new Headers(),
      status: 500,
    } as Response)

    notion = new Client({
      fetch: mockFetch,
      retry: {
        maxRetries: 2,
        retryOnServerError: false,
      },
    })

    await expect(
      notion.request({
        path: "users",
        method: "get",
      })
    ).rejects.toThrow()

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("should use exponential backoff for retry delays", async () => {
    const startTime = Date.now()
    let callTimes: number[] = []

    // Always return rate limit error
    mockFetch.mockImplementation(() => {
      callTimes.push(Date.now() - startTime)
      return Promise.resolve({
        ok: false,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              code: "rate_limited",
              message: "Rate limited",
              object: "error",
              status: 429,
            })
          ),
        headers: new Headers(),
        status: 429,
      } as Response)
    })

    notion = new Client({
      fetch: mockFetch,
      retry: {
        maxRetries: 2,
        initialDelayMs: 100,
        backoffMultiplier: 2,
      },
    })

    await expect(
      notion.request({
        path: "users",
        method: "get",
      })
    ).rejects.toThrow()

    expect(mockFetch).toHaveBeenCalledTimes(3)
    
    // Check that delays are approximately exponential
    // First call should be immediate, second after ~100ms, third after ~200ms
    expect(callTimes[0]).toBeLessThan(50) // Immediate
    expect(callTimes[1]).toBeGreaterThan(80) // ~100ms delay
    expect(callTimes[2]).toBeGreaterThan(180) // ~200ms additional delay
  })

  it("should respect Retry-After header when present", async () => {
    const retryAfterSeconds = 2
    
    // First call returns rate limit with Retry-After header, second succeeds
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              code: "rate_limited",
              message: "Rate limited",
              object: "error",
              status: 429,
            })
          ),
        headers: new Headers({
          "Retry-After": retryAfterSeconds.toString(),
        }),
        status: 429,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ success: true })),
        headers: new Headers(),
        status: 200,
      } as Response)

    notion = new Client({
      fetch: mockFetch,
      retry: {
        maxRetries: 2,
        initialDelayMs: 100, // This should be overridden by Retry-After
        respectRetryAfter: true,
      },
    })

    const startTime = Date.now()
    const result = await notion.request({
      path: "users",
      method: "get",
    })
    const endTime = Date.now()

    expect(result).toEqual({ success: true })
    expect(mockFetch).toHaveBeenCalledTimes(2)
    
    // Should have waited approximately 2 seconds (Retry-After value)
    const actualDelay = endTime - startTime
    expect(actualDelay).toBeGreaterThan(1800) // Allow some tolerance
    expect(actualDelay).toBeLessThan(2500)
  })

  it("should not retry non-idempotent methods by default", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            code: "internal_server_error",
            message: "Internal server error",
            object: "error",
            status: 500,
          })
        ),
      headers: new Headers(),
      status: 500,
    } as Response)

    notion = new Client({
      fetch: mockFetch,
      retry: {
        maxRetries: 2,
        retryOnServerError: true,
        retryNonIdempotentMethods: false, // Default
      },
    })

    await expect(
      notion.request({
        path: "pages",
        method: "post", // Non-idempotent method
        body: { title: "Test" },
      })
    ).rejects.toThrow()

    expect(mockFetch).toHaveBeenCalledTimes(1) // No retries
  })

  it("should retry non-idempotent methods when explicitly enabled", async () => {
    // First call returns server error, second succeeds
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              code: "internal_server_error",
              message: "Internal server error",
              object: "error",
              status: 500,
            })
          ),
        headers: new Headers(),
        status: 500,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ success: true })),
        headers: new Headers(),
        status: 200,
      } as Response)

    notion = new Client({
      fetch: mockFetch,
      retry: {
        maxRetries: 2,
        initialDelayMs: 100,
        retryOnServerError: true,
        retryNonIdempotentMethods: true, // Explicitly enabled
      },
    })

    const result = await notion.request({
      path: "pages",
      method: "post", // Non-idempotent method
      body: { title: "Test" },
    })

    expect(result).toEqual({ success: true })
    expect(mockFetch).toHaveBeenCalledTimes(2) // Should retry
  })

  it("should retry idempotent methods by default", async () => {
    // First call returns server error, second succeeds
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              code: "internal_server_error",
              message: "Internal server error",
              object: "error",
              status: 500,
            })
          ),
        headers: new Headers(),
        status: 500,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ success: true })),
        headers: new Headers(),
        status: 200,
      } as Response)

    notion = new Client({
      fetch: mockFetch,
      retry: {
        maxRetries: 2,
        initialDelayMs: 100,
        retryOnServerError: true,
        retryNonIdempotentMethods: false, // Default
      },
    })

    const result = await notion.request({
      path: "users",
      method: "get", // Idempotent method
    })

    expect(result).toEqual({ success: true })
    expect(mockFetch).toHaveBeenCalledTimes(2) // Should retry
  })

  it("should disable Retry-After header respect when configured", async () => {
    // First call returns rate limit with Retry-After header, second succeeds
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              code: "rate_limited",
              message: "Rate limited",
              object: "error",
              status: 429,
            })
          ),
        headers: new Headers({
          "Retry-After": "5", // 5 seconds
        }),
        status: 429,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ success: true })),
        headers: new Headers(),
        status: 200,
      } as Response)

    notion = new Client({
      fetch: mockFetch,
      retry: {
        maxRetries: 2,
        initialDelayMs: 100,
        respectRetryAfter: false, // Disabled
      },
    })

    const startTime = Date.now()
    const result = await notion.request({
      path: "users",
      method: "get",
    })
    const endTime = Date.now()

    expect(result).toEqual({ success: true })
    expect(mockFetch).toHaveBeenCalledTimes(2)
    
    // Should use exponential backoff (100ms), not Retry-After (5s)
    const actualDelay = endTime - startTime
    expect(actualDelay).toBeLessThan(1000) // Much less than 5 seconds
  })
})
