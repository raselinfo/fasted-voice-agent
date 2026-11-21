export type VadAssetManifestEntry = {
  sourcePath: string;
  targetRelativePath: string;
};

export function resolveVadAssetManifest(): Promise<VadAssetManifestEntry[]>;

export function syncVadAssets(options?: {
  targetRoot?: string;
  checkOnly?: boolean;
}): Promise<VadAssetManifestEntry[]>;
