'use client'

import { use } from 'react'
import { useRouter } from 'next/navigation'
import { OrderOperativeContent } from '@/components/orders/OrderOperativeContent'

export default function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()

  return (
    <OrderOperativeContent orderId={id} onBack={() => router.back()} />
  )
}
