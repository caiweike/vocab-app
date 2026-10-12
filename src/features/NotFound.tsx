import { Link } from 'react-router-dom'
import { Button } from '@/components/ui'

export default function NotFound() {
  return (
    <div className="flex flex-col items-center gap-4 py-20 text-center">
      <div className="text-5xl">🧭</div>
      <p className="text-slate-500">页面不存在</p>
      <Link to="/">
        <Button variant="outline">回到首页</Button>
      </Link>
    </div>
  )
}
