export type GroqApiKeyRecord = {
  apiKey: string;
  label: string;
};

function splitGroqApiKeys(rawValue: string | undefined): string[] {
  if (!rawValue) {
    return [];
  }

  return rawValue
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function fnv1a64(input: string): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * prime);
  }

  return hash;
}

export function parseGroqApiKeys(rawValue: string | undefined, fallbackValue?: string | undefined): GroqApiKeyRecord[] {
  const pooledKeys = splitGroqApiKeys(rawValue).map((apiKey, index) => ({
    apiKey,
    label: `pool-${index + 1}`,
  }));

  if (pooledKeys.length > 0) {
    return pooledKeys;
  }

  const singleKey = fallbackValue?.trim();
  if (!singleKey) {
    return [];
  }

  return [
    {
      apiKey: singleKey,
      label: "primary",
    },
  ];
}

export function rankGroqApiKeys(sessionId: string, keys: GroqApiKeyRecord[]): GroqApiKeyRecord[] {
  return [...keys].sort((left, right) => {
    const leftScore = fnv1a64(`${sessionId}:${left.label}`);
    const rightScore = fnv1a64(`${sessionId}:${right.label}`);
    if (leftScore === rightScore) {
      return 0;
    }
    return leftScore > rightScore ? -1 : 1;
  });
}

export function selectGroqApiKey(sessionId: string, keys: GroqApiKeyRecord[]): GroqApiKeyRecord | null {
  return rankGroqApiKeys(sessionId, keys)[0] ?? null;
}
