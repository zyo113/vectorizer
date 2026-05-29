import { NextRequest, NextResponse } from 'next/server';
import { vectorize } from '@/lib/vectorize-engine';
import { defaultOptions } from '@/lib/vectorize-types';
import type { VectorizeOptions } from '@/lib/vectorize-types';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export async function POST(request: NextRequest) {
  try {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json(
        { error: '请使用 multipart/form-data 格式上传图片文件' },
        { status: 400 }
      );
    }
    const imageFile = formData.get('image') as File | null;

    if (!imageFile) {
      return NextResponse.json({ error: '请上传图片文件' }, { status: 400 });
    }

    // Check file size
    if (imageFile.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: '文件大小不能超过 10MB' }, { status: 400 });
    }

    // Validate file type
    const validTypes = ['image/jpeg', 'image/png', 'image/bmp', 'image/gif', 'image/webp', 'image/tiff'];
    if (!validTypes.includes(imageFile.type)) {
      return NextResponse.json(
        { error: '不支持的图片格式，请上传 JPEG/PNG/BMP/GIF/WebP/TIFF 文件' },
        { status: 400 }
      );
    }

    // Parse options from form data
    const mode = formData.get('mode') as string | null;
    const denoise = formData.get('denoise') as string | null;
    const threshold = formData.get('threshold') as string | null;
    const colorCount = formData.get('colorCount') as string | null;
    const turdSize = formData.get('turdSize') as string | null;
    const alphaMax = formData.get('alphaMax') as string | null;
    const optCurve = formData.get('optCurve') as string | null;
    const optTolerance = formData.get('optTolerance') as string | null;

    const options: VectorizeOptions = {
      mode: mode === 'bw' ? 'bw' : 'color',
      denoise: denoise ? parseFloat(denoise) : defaultOptions.denoise,
      threshold: threshold ? parseInt(threshold, 10) : defaultOptions.threshold,
      colorCount: colorCount ? parseInt(colorCount, 10) : defaultOptions.colorCount,
      turdSize: turdSize ? parseFloat(turdSize) : defaultOptions.turdSize,
      alphaMax: alphaMax ? parseFloat(alphaMax) : defaultOptions.alphaMax,
      optCurve: optCurve !== 'false',
      optTolerance: optTolerance ? parseFloat(optTolerance) : defaultOptions.optTolerance,
      decimalPrecision: 2,
    };

    // Convert file to buffer
    const arrayBuffer = await imageFile.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Vectorize (includes EPS generation)
    const result = await vectorize(buffer, options);

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('Vectorization error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: '矢量化处理失败', details: message },
      { status: 500 }
    );
  }
}
