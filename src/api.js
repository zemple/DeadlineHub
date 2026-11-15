export async function request(path, options = {}) {
  const { json, pdf, sessionId } = options;
  const post = json !== undefined || pdf !== undefined;
  const response = await fetch(path, {
    method: post ? 'POST' : 'GET',
    headers: {
      ...(post && { 'Content-Type': pdf === undefined ? 'application/json' : 'application/pdf' }),
      ...(sessionId && { 'X-DeadlineHub-Session': sessionId }),
    },
    body: post ? pdf ?? JSON.stringify(json) : undefined,
  });
  if (response.status === 204) return null;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || 'The request failed. Try again.');
    error.status = response.status;
    throw error;
  }
  return result;
}
