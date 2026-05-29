// Types and defaults shared between client and server

export interface VectorizeOptions {
  mode: 'bw' | 'color';
  denoise: number;       // 0-5
  threshold: number;     // 0-255, for BW mode
  colorCount: number;    // 2-16, for color mode
  turdSize: number;      // 1-100
  alphaMax: number;      // 0-1.334
  optCurve: boolean;
  optTolerance: number;  // 0-5
  decimalPrecision: number; // 0-6
}

export const defaultOptions: VectorizeOptions = {
  mode: 'color',
  denoise: 0,
  threshold: 128,
  colorCount: 12,
  turdSize: 5,
  alphaMax: 1,
  optCurve: true,
  optTolerance: 0.2,
  decimalPrecision: 2,
};

export interface VectorizeResult {
  svg: string;
  eps: string;
  width: number;
  height: number;
  pathCount: number;
  nodeCount: number;
  fileSize: number;
  epsSize: number;
  processingTime: number;
  originalSize: { width: number; height: number };
  colorPalette: string[];
}
