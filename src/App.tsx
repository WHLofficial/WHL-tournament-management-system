import { Routes, Route } from "react-router";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
    </Routes>
  );
}

function Home() {
  return (
    <main className="container">
      <h1>WHL 赛事系统</h1>
      <p>脚手架就绪。</p>
      <p>
        <a href="/api/health">后端健康检查</a>
      </p>
    </main>
  );
}
