/**
 * [INPUT]: 依赖 react-dom/client、App 根组件、theme.css 与 React Flow 基础样式
 * [OUTPUT]: 对外提供应用挂载入口
 * [POS]: web 的启动点，只做挂载不做逻辑
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './theme.css';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(<App />);
