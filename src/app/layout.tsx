import type { Metadata } from 'next';
import { Inspector } from 'react-dev-inspector';
import './globals.css';

export const metadata: Metadata = {
  title: 'VectorForge - 位图转矢量引擎',
  description: '工业级位图转矢量工具，支持 K-Means 色彩量化、贝塞尔曲线优化，输出 SVG/EPS 矢量文件',
  keywords: ['矢量化', '位图转矢量', 'SVG', 'EPS', 'potrace', '贝塞尔曲线'],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const isDev = process.env.COZE_PROJECT_ENV === 'DEV';

  return (
    <html lang="zh-CN" className="dark">
      <body className={`antialiased`}>
        {isDev && <Inspector />}
        {children}
      </body>
    </html>
  );
}
