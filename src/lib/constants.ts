// Public Humangent API coordinates used by the community node.
//
// Verified n8n community nodes must not read developer-machine environment
// variables at runtime. The production API base URL is intentionally public
// package metadata, while preview/test service addresses stay in GitHub
// Actions variables and are not consumed by the runtime package.

export const HUMANGENT_API_URL = "https://api.humangent.io";

// Kept as a separate constant because older Humangent alpha backends used a
// Supabase gateway anon key. Production API traffic does not require one; when
// empty, the HTTP client omits Supabase-specific headers entirely.
export const HUMANGENT_ANON_KEY = "";
