import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { AiProvider, AiAgentMode } from '@/types'

const PROVIDERS: AiProvider[]  = ['openai', 'gemini']
const MODES:     AiAgentMode[] = ['off', 'suggest', 'auto', 'after_hours']

// GET — config del agente IA para la tienda del admin autenticado.
// Si no existe (tienda creada después de la migración 036), se crea
// una fila default al vuelo.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles').select('role, store_id').eq('id', user.id).single()
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Solo admins' }, { status: 403 })
  if (!profile.store_id) return NextResponse.json({ error: 'Sin tienda asignada' }, { status: 400 })

  const { data: existing, error: selectErr } = await supabase
    .from('ai_agent_config').select('*').eq('store_id', profile.store_id).maybeSingle()
  if (selectErr) return NextResponse.json({ error: selectErr.message }, { status: 400 })

  if (existing) return NextResponse.json(existing)

  const { data: created, error: insertErr } = await supabase
    .from('ai_agent_config')
    .insert({ store_id: profile.store_id })
    .select('*')
    .single()
  if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 400 })

  return NextResponse.json(created)
}

// PATCH — actualiza campos del perfil/proveedor/prompt/modo del agente.
// Solo admin. api_key_ref guarda el NOMBRE de la env var, nunca la key real.
export async function PATCH(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles').select('role, store_id').eq('id', user.id).single()
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Solo admins' }, { status: 403 })
  if (!profile.store_id) return NextResponse.json({ error: 'Sin tienda asignada' }, { status: 400 })

  const body = await request.json()
  const updates: Record<string, unknown> = {}

  if ('agent_name' in body) {
    const name = String(body.agent_name ?? '').trim()
    if (!name) return NextResponse.json({ error: 'agent_name no puede estar vacío' }, { status: 400 })
    updates.agent_name = name
  }
  if ('provider' in body) {
    if (body.provider !== null && !PROVIDERS.includes(body.provider)) {
      return NextResponse.json({ error: 'provider inválido' }, { status: 400 })
    }
    updates.provider = body.provider
  }
  if ('model' in body)         updates.model         = body.model ? String(body.model) : null
  if ('api_key_ref' in body)   updates.api_key_ref   = body.api_key_ref ? String(body.api_key_ref) : null
  if ('system_prompt' in body) updates.system_prompt = body.system_prompt ? String(body.system_prompt) : null
  if ('mode' in body) {
    if (!MODES.includes(body.mode)) return NextResponse.json({ error: 'mode inválido' }, { status: 400 })
    updates.mode = body.mode
  }
  if ('is_active' in body) updates.is_active = Boolean(body.is_active)

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Sin campos para actualizar' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('ai_agent_config')
    .update(updates)
    .eq('store_id', profile.store_id)
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json(data)
}
