// Helpers base para Shopify Admin API (REST 2024-07 + GraphQL)

export const SHOPIFY_API_VERSION = '2024-07'

function getCredentials(): { shopDomain: string; accessToken: string } {
  const shopDomain  = process.env.SHOPIFY_SHOP_DOMAIN
  const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN
  if (!shopDomain || !accessToken) {
    throw new Error('SHOPIFY_SHOP_DOMAIN o SHOPIFY_ADMIN_ACCESS_TOKEN no configurados')
  }
  return { shopDomain, accessToken }
}

export function shopifyRestUrl(path: string): string {
  const { shopDomain } = getCredentials()
  return `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/${path}`
}

export function shopifyHeaders(): Record<string, string> {
  const { accessToken } = getCredentials()
  return {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json',
  }
}

export function shopifyGraphQLUrl(): string {
  const { shopDomain } = getCredentials()
  return `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`
}

export async function shopifyGraphQL<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(shopifyGraphQLUrl(), {
    method:  'POST',
    headers: shopifyHeaders(),
    body:    JSON.stringify({ query, variables }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Shopify GraphQL HTTP ${res.status}: ${text}`)
  }
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] }
  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL error: ${json.errors.map(e => e.message).join(', ')}`)
  }
  return json.data as T
}
