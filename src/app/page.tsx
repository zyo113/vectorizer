'use client';

import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  Upload,
  Settings2,
  Download,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Image as ImageIcon,
  FileCode2,
  ArrowLeftRight,
  Layers,
  Timer,
  HardDrive,
  Circle,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { defaultOptions } from '@/lib/vectorize-types';
import type { VectorizeOptions, VectorizeResult } from '@/lib/vectorize-types';

// ============================================================
// Main Page Component
// ============================================================

export default function VectorizerPage() {
  // State
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [options, setOptions] = useState<VectorizeOptions>(defaultOptions);
  const [isConverting, setIsConverting] = useState(false);
  const [result, setResult] = useState<VectorizeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sliderPos, setSliderPos] = useState(50);
  const [isDragging, setIsDragging] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [showParams, setShowParams] = useState(true);
  const [copied, setCopied] = useState<'svg' | 'eps' | null>(null);
  const [previewTab, setPreviewTab] = useState<'compare' | 'vector' | 'code'>('compare');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);

  // File handling
  const handleFileSelect = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) {
      setError('请选择图片文件');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('文件大小不能超过 10MB');
      return;
    }
    setImageFile(file);
    setError(null);
    setResult(null);

    const reader = new FileReader();
    reader.onload = (e) => {
      setImagePreview(e.target?.result as string);
    };
    reader.readAsDataURL(file);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) handleFileSelect(file);
    },
    [handleFileSelect]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  // Conversion
  const handleConvert = useCallback(async () => {
    if (!imageFile) return;

    setIsConverting(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('image', imageFile);
      formData.append('mode', options.mode);
      formData.append('denoise', options.denoise.toString());
      formData.append('threshold', options.threshold.toString());
      formData.append('colorCount', options.colorCount.toString());
      formData.append('turdSize', options.turdSize.toString());
      formData.append('alphaMax', options.alphaMax.toString());
      formData.append('optCurve', options.optCurve.toString());
      formData.append('optTolerance', options.optTolerance.toString());

      const response = await fetch('/api/vectorize', {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || '转换失败');
      }

      setResult(data.data);
      setPreviewTab('compare');
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误');
    } finally {
      setIsConverting(false);
    }
  }, [imageFile, options]);

  // Download helpers
  const downloadFile = useCallback((content: string, filename: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const copyToClipboard = useCallback(async (content: string, type: 'svg' | 'eps') => {
    await navigator.clipboard.writeText(content);
    setCopied(type);
    setTimeout(() => setCopied(null), 2000);
  }, []);

  // Comparison slider drag handling
  const handleMouseDown = useCallback(() => {
    setIsDragging(true);
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging || !previewContainerRef.current) return;
      const rect = previewContainerRef.current.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      setSliderPos(Math.max(2, Math.min(98, x)));
    },
    [isDragging]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Zoom
  const handleZoomIn = useCallback(() => setZoom((z) => Math.min(z * 1.5, 20)), []);
  const handleZoomOut = useCallback(() => setZoom((z) => Math.max(z / 1.5, 0.5)), []);
  const handleZoomReset = useCallback(() => setZoom(1), []);

  // Wheel zoom
  useEffect(() => {
    const container = previewContainerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        setZoom((z) => Math.max(0.5, Math.min(20, z * delta)));
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, []);

  // Reset
  const handleReset = useCallback(() => {
    setImageFile(null);
    setImagePreview(null);
    setResult(null);
    setError(null);
    setZoom(1);
    setSliderPos(50);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  // Get base filename without extension
  const baseName = imageFile?.name.replace(/\.[^.]+$/, '') || 'output';

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Header */}
      <header className="border-b border-border px-6 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-cyan-400/10 flex items-center justify-center">
            <Layers className="w-4 h-4 text-cyan-400" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">VectorForge</h1>
            <p className="text-xs text-muted-foreground">位图转矢量引擎</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {imageFile && (
            <Button variant="ghost" size="sm" onClick={handleReset} className="text-muted-foreground">
              <RotateCcw className="w-4 h-4 mr-1" />
              重置
            </Button>
          )}
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel */}
        <div className="w-80 border-r border-border flex flex-col shrink-0 overflow-y-auto">
          {/* Upload Zone */}
          <div className="p-4">
            <h2 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
              <Upload className="w-3.5 h-3.5" />
              图片上传
            </h2>
            <div
              className={`relative border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
                imageFile
                  ? 'border-cyan-400/30 bg-cyan-400/5'
                  : 'border-border hover:border-cyan-400/50 hover:bg-cyan-400/5'
              }`}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept="image/jpeg,image/png,image/bmp,image/gif,image/webp,image/tiff"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFileSelect(file);
                }}
              />
              {imagePreview ? (
                <div className="space-y-2">
                  <img
                    src={imagePreview}
                    alt="Preview"
                    className="w-full h-32 object-contain rounded"
                  />
                  <p className="text-xs text-muted-foreground truncate">{imageFile?.name}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <ImageIcon className="w-8 h-8 mx-auto text-muted-foreground/50" />
                  <p className="text-sm text-muted-foreground">拖拽图片到此处或点击选择</p>
                  <p className="text-xs text-muted-foreground/60">JPEG / PNG / BMP / GIF / WebP / TIFF</p>
                </div>
              )}
            </div>
          </div>

          <Separator />

          {/* Parameter Panel */}
          <div className="p-4 flex-1">
            <button
              className="flex items-center justify-between w-full mb-4"
              onClick={() => setShowParams(!showParams)}
            >
              <h2 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Settings2 className="w-3.5 h-3.5" />
                参数设置
              </h2>
              {showParams ? (
                <ChevronUp className="w-4 h-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="w-4 h-4 text-muted-foreground" />
              )}
            </button>

            {showParams && (
              <div className="space-y-5">
                {/* Mode Toggle */}
                <div className="space-y-2">
                  <Label className="text-xs">转换模式</Label>
                  <ToggleGroup
                    type="single"
                    value={options.mode}
                    onValueChange={(v) => {
                      if (v) setOptions({ ...options, mode: v as 'bw' | 'color' });
                    }}
                    className="justify-start"
                  >
                    <ToggleGroupItem
                      value="color"
                      className="text-xs data-[state=on]:bg-cyan-400/15 data-[state=on]:text-cyan-400"
                    >
                      彩色矢量
                    </ToggleGroupItem>
                    <ToggleGroupItem
                      value="bw"
                      className="text-xs data-[state=on]:bg-cyan-400/15 data-[state=on]:text-cyan-400"
                    >
                      黑白轮廓
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>

                {/* BW Threshold */}
                {options.mode === 'bw' && (
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <Label className="text-xs">二值化阈值</Label>
                      <span className="text-xs font-mono text-cyan-400">{options.threshold}</span>
                    </div>
                    <Slider
                      value={[options.threshold]}
                      min={0}
                      max={255}
                      step={1}
                      onValueChange={([v]) => setOptions({ ...options, threshold: v })}
                    />
                    <p className="text-[10px] text-muted-foreground/60">
                      较低值保留更多暗部细节，较高值保留更多亮部
                    </p>
                  </div>
                )}

                {/* Color Count */}
                {options.mode === 'color' && (
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <Label className="text-xs">色彩数量</Label>
                      <span className="text-xs font-mono text-cyan-400">{options.colorCount}</span>
                    </div>
                    <Slider
                      value={[options.colorCount]}
                      min={2}
                      max={16}
                      step={1}
                      onValueChange={([v]) => setOptions({ ...options, colorCount: v })}
                    />
                    <p className="text-[10px] text-muted-foreground/60">
                      K-Means 色彩量化级数，越多色彩还原越精准
                    </p>
                  </div>
                )}

                {/* Denoise */}
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <Label className="text-xs">噪点抑制</Label>
                    <span className="text-xs font-mono text-cyan-400">{options.denoise.toFixed(1)}</span>
                  </div>
                  <Slider
                    value={[options.denoise]}
                    min={0}
                    max={5}
                    step={0.5}
                    onValueChange={([v]) => setOptions({ ...options, denoise: v })}
                  />
                  <p className="text-[10px] text-muted-foreground/60">
                    双边滤波平滑噪点，值越大路径越简洁
                  </p>
                </div>

                {/* Turd Size */}
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <Label className="text-xs">最小特征尺寸</Label>
                    <span className="text-xs font-mono text-cyan-400">{options.turdSize}</span>
                  </div>
                  <Slider
                    value={[options.turdSize]}
                    min={1}
                    max={100}
                    step={1}
                    onValueChange={([v]) => setOptions({ ...options, turdSize: v })}
                  />
                  <p className="text-[10px] text-muted-foreground/60">
                    抑制小于此像素面积的斑点，减少路径碎片
                  </p>
                </div>

                {/* Alpha Max */}
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <Label className="text-xs">角点阈值</Label>
                    <span className="text-xs font-mono text-cyan-400">{options.alphaMax.toFixed(2)}</span>
                  </div>
                  <Slider
                    value={[options.alphaMax]}
                    min={0}
                    max={1.334}
                    step={0.01}
                    onValueChange={([v]) => setOptions({ ...options, alphaMax: v })}
                  />
                  <p className="text-[10px] text-muted-foreground/60">
                    0 = 保留更多尖角，1.334 = 更平滑曲线
                  </p>
                </div>

                {/* Curve Optimization */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">曲线优化</Label>
                    <Switch
                      checked={options.optCurve}
                      onCheckedChange={(v) => setOptions({ ...options, optCurve: v })}
                    />
                  </div>

                  {options.optCurve && (
                    <div className="space-y-2">
                      <div className="flex justify-between">
                        <Label className="text-xs">优化容差</Label>
                        <span className="text-xs font-mono text-cyan-400">
                          {options.optTolerance.toFixed(2)}
                        </span>
                      </div>
                      <Slider
                        value={[options.optTolerance]}
                        min={0}
                        max={5}
                        step={0.05}
                        onValueChange={([v]) => setOptions({ ...options, optTolerance: v })}
                      />
                      <p className="text-[10px] text-muted-foreground/60">
                        较高值减少节点但降低精度，较低值保留更多细节
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Convert Button */}
          <div className="p-4 border-t border-border">
            <Button
              className="w-full bg-cyan-400 hover:bg-cyan-300 text-black font-medium"
              disabled={!imageFile || isConverting}
              onClick={handleConvert}
            >
              {isConverting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  正在转换...
                </>
              ) : (
                <>
                  <Layers className="w-4 h-4 mr-2" />
                  开始矢量化
                </>
              )}
            </Button>
          </div>
        </div>

        {/* Right Panel - Preview & Results */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {error && (
            <div className="mx-6 mt-4 p-3 bg-destructive/10 border border-destructive/20 rounded-lg flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}

          {!imagePreview ? (
            /* Empty State */
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center space-y-4">
                <div className="w-20 h-20 rounded-2xl bg-cyan-400/5 border border-cyan-400/10 flex items-center justify-center mx-auto">
                  <Layers className="w-10 h-10 text-cyan-400/30" />
                </div>
                <div>
                  <p className="text-lg font-medium text-muted-foreground">上传位图开始矢量化</p>
                  <p className="text-sm text-muted-foreground/60 mt-1">
                    支持 K-Means 色彩量化、贝塞尔曲线优化、SVG/EPS 输出
                  </p>
                </div>
              </div>
            </div>
          ) : (
            /* Preview Area */
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Preview Tabs */}
              <div className="px-6 pt-4 flex items-center justify-between">
                <Tabs value={previewTab} onValueChange={(v) => setPreviewTab(v as 'compare' | 'vector' | 'code')}>
                  <TabsList className="bg-secondary/50">
                    <TabsTrigger value="compare" className="text-xs">
                      <ArrowLeftRight className="w-3.5 h-3.5 mr-1" />
                      对比预览
                    </TabsTrigger>
                    <TabsTrigger value="vector" className="text-xs">
                      <FileCode2 className="w-3.5 h-3.5 mr-1" />
                      矢量输出
                    </TabsTrigger>
                    <TabsTrigger value="code" className="text-xs">
                      <FileCode2 className="w-3.5 h-3.5 mr-1" />
                      SVG 代码
                    </TabsTrigger>
                  </TabsList>
                </Tabs>

                {/* Zoom Controls */}
                {result && (
                  <div className="flex items-center gap-1">
                    <Badge variant="outline" className="text-[10px] font-mono mr-2">
                      {zoom.toFixed(1)}x
                    </Badge>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleZoomOut}>
                      <ZoomOut className="w-3.5 h-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleZoomReset}>
                      <RotateCcw className="w-3.5 h-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleZoomIn}>
                      <ZoomIn className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                )}
              </div>

              {/* Preview Content */}
              <div
                ref={previewContainerRef}
                className="flex-1 overflow-auto p-6"
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
              >
                {/* Compare Mode */}
                {previewTab === 'compare' && result && (
                  <div className="relative w-full h-full flex items-center justify-center">
                    <div
                      className="relative overflow-hidden rounded-lg border border-border bg-[repeating-conic-gradient(#1c1c1f_0%_25%,#141416_0%_50%)] bg-[length:20px_20px]"
                      style={{
                        width: Math.min(result.width, 800),
                        height: Math.min(result.height, 600),
                        maxWidth: '100%',
                      }}
                    >
                      {/* SVG Layer (left side) */}
                      <div
                        className="absolute inset-0 flex items-center justify-center"
                        style={{
                          clipPath: `polygon(0 0, ${sliderPos}% 0, ${sliderPos}% 100%, 0 100%)`,
                          transform: `scale(${zoom})`,
                          transformOrigin: 'center',
                        }}
                        dangerouslySetInnerHTML={{ __html: result.svg }}
                      />

                      {/* Original Image Layer (right side) */}
                      <div
                        className="absolute inset-0 flex items-center justify-center"
                        style={{
                          clipPath: `polygon(${sliderPos}% 0, 100% 0, 100% 100%, ${sliderPos}% 100%)`,
                        }}
                      >
                        <img
                          src={imagePreview || ''}
                          alt="Original"
                          className="max-w-full max-h-full object-contain"
                          style={{ transform: `scale(${zoom})`, transformOrigin: 'center' }}
                        />
                      </div>

                      {/* Slider Handle */}
                      <div
                        className="absolute top-0 bottom-0 w-0.5 bg-cyan-400 cursor-col-resize z-10"
                        style={{ left: `${sliderPos}%` }}
                        onMouseDown={handleMouseDown}
                      >
                        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-cyan-400 flex items-center justify-center shadow-lg shadow-cyan-400/20">
                          <ArrowLeftRight className="w-4 h-4 text-black" />
                        </div>
                      </div>

                      {/* Labels */}
                      <div className="absolute top-3 left-3 z-20">
                        <Badge className="bg-cyan-400/90 text-black text-[10px]">矢量</Badge>
                      </div>
                      <div className="absolute top-3 right-3 z-20">
                        <Badge className="bg-white/90 text-black text-[10px]">原图</Badge>
                      </div>
                    </div>
                  </div>
                )}

                {/* Vector Only Mode */}
                {previewTab === 'vector' && result && (
                  <div className="w-full h-full flex items-center justify-center">
                    <div
                      className="rounded-lg border border-border bg-[repeating-conic-gradient(#1c1c1f_0%_25%,#141416_0%_50%)] bg-[length:20px_20px] p-4 overflow-auto"
                      style={{ maxWidth: '100%', maxHeight: '100%' }}
                    >
                      <div
                        style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}
                        dangerouslySetInnerHTML={{ __html: result.svg }}
                      />
                    </div>
                  </div>
                )}

                {/* Code Mode */}
                {previewTab === 'code' && result && (
                  <div className="w-full h-full relative">
                    <div className="absolute top-2 right-2 z-10 flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => copyToClipboard(result.svg, 'svg')}
                      >
                        {copied === 'svg' ? (
                          <Check className="w-3 h-3 mr-1 text-emerald-400" />
                        ) : (
                          <Copy className="w-3 h-3 mr-1" />
                        )}
                        复制 SVG
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => copyToClipboard(result.eps, 'eps')}
                      >
                        {copied === 'eps' ? (
                          <Check className="w-3 h-3 mr-1 text-emerald-400" />
                        ) : (
                          <Copy className="w-3 h-3 mr-1" />
                        )}
                        复制 EPS
                      </Button>
                    </div>
                    <pre className="w-full h-full overflow-auto rounded-lg border border-border bg-secondary/30 p-4 text-xs font-mono text-muted-foreground leading-relaxed">
                      <code>{result.svg}</code>
                    </pre>
                  </div>
                )}

                {/* No result yet - show original */}
                {!result && imagePreview && !isConverting && (
                  <div className="w-full h-full flex items-center justify-center">
                    <div className="rounded-lg border border-border overflow-hidden">
                      <img
                        src={imagePreview}
                        alt="Original"
                        className="max-w-full max-h-[500px] object-contain"
                      />
                    </div>
                  </div>
                )}

                {/* Loading State */}
                {isConverting && (
                  <div className="w-full h-full flex items-center justify-center">
                    <div className="text-center space-y-4">
                      <div className="relative w-16 h-16 mx-auto">
                        <div className="absolute inset-0 rounded-full border-2 border-cyan-400/20" />
                        <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-cyan-400 animate-spin" />
                        <div className="absolute inset-2 rounded-full border-2 border-transparent border-b-cyan-400/60 animate-spin" style={{ animationDirection: 'reverse', animationDuration: '1.5s' }} />
                      </div>
                      <div>
                        <p className="text-sm font-medium">正在矢量化</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {options.mode === 'color'
                            ? `K-Means 色彩量化 (${options.colorCount} 色) + 轮廓追踪...`
                            : `二值化处理 + 轮廓追踪...`}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Quality Report & Downloads */}
              {result && (
                <div className="border-t border-border p-4 space-y-4">
                  {/* Metrics */}
                  <div className="grid grid-cols-4 gap-3">
                    <div className="bg-secondary/30 rounded-lg p-3 text-center">
                      <Layers className="w-4 h-4 mx-auto mb-1 text-cyan-400" />
                      <p className="text-lg font-semibold font-mono">{result.pathCount}</p>
                      <p className="text-[10px] text-muted-foreground">路径数</p>
                    </div>
                    <div className="bg-secondary/30 rounded-lg p-3 text-center">
                      <Circle className="w-4 h-4 mx-auto mb-1 text-cyan-400" />
                      <p className="text-lg font-semibold font-mono">{result.nodeCount}</p>
                      <p className="text-[10px] text-muted-foreground">节点数</p>
                    </div>
                    <div className="bg-secondary/30 rounded-lg p-3 text-center">
                      <HardDrive className="w-4 h-4 mx-auto mb-1 text-cyan-400" />
                      <p className="text-lg font-semibold font-mono">
                        {result.fileSize > 1024
                          ? `${(result.fileSize / 1024).toFixed(1)}K`
                          : `${result.fileSize}B`}
                      </p>
                      <p className="text-[10px] text-muted-foreground">文件大小</p>
                    </div>
                    <div className="bg-secondary/30 rounded-lg p-3 text-center">
                      <Timer className="w-4 h-4 mx-auto mb-1 text-cyan-400" />
                      <p className="text-lg font-semibold font-mono">{(result.processingTime / 1000).toFixed(1)}s</p>
                      <p className="text-[10px] text-muted-foreground">处理耗时</p>
                    </div>
                  </div>

                  {/* Color Palette */}
                  {result.colorPalette.length > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-muted-foreground shrink-0">色板:</span>
                      <div className="flex gap-1 flex-wrap">
                        {result.colorPalette.map((color, i) => (
                          <div
                            key={i}
                            className="w-6 h-6 rounded border border-border/50"
                            style={{ backgroundColor: color }}
                            title={color}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Download Buttons */}
                  <div className="flex items-center gap-2">
                    <Button
                      className="bg-cyan-400 hover:bg-cyan-300 text-black font-medium"
                      onClick={() =>
                        downloadFile(result.svg, `${baseName}.svg`, 'image/svg+xml')
                      }
                    >
                      <Download className="w-4 h-4 mr-1" />
                      下载 SVG
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() =>
                        downloadFile(result.eps, `${baseName}.eps`, 'application/postscript')
                      }
                    >
                      <Download className="w-4 h-4 mr-1" />
                      下载 EPS
                    </Button>
                    <div className="flex-1" />
                    <div className="flex items-center gap-1 text-emerald-400">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span className="text-xs">转换完成</span>
                    </div>
                  </div>

                  {/* Original size info */}
                  <div className="text-[10px] text-muted-foreground/50 flex items-center gap-4">
                    <span>原图: {result.originalSize.width}x{result.originalSize.height}px</span>
                    <span>输出: {result.width}x{result.height}px</span>
                    <span>EPS: {(result.epsSize / 1024).toFixed(1)}KB</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
