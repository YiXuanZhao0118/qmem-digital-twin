import asyncio
import asyncpg
import json

async def main():
    c = await asyncpg.connect(host='localhost', port=55432, user='qmem', password='qmem_password', database='qmem_twin')
    # Find IO-3-850-HP component and its bindings
    rows = await c.fetch("""
        SELECT b.id, b.parent_binding_id, b.target_kind, b.role,
               b.local_x_mm, b.local_y_mm, b.local_z_mm,
               b.local_rx_deg, b.local_ry_deg, b.local_rz_deg,
               b.tunable_axes, b.properties, b.sort_order
          FROM component_bindings b
          JOIN components c ON c.id = b.component_id
         WHERE c.model = 'IO-3-850-HP' AND c.archived_at IS NULL
         ORDER BY b.sort_order NULLS LAST, b.id
    """)
    print(f"IO-3-850-HP has {len(rows)} bindings:")
    for r in rows:
        props = (json.loads(r['properties']) if r['properties'] else {})
        role_label = props.get('role_label', '(no label)')
        print(f"  id={str(r['id'])[:8]} parent={str(r['parent_binding_id'])[:8] if r['parent_binding_id'] else 'ROOT':8} "
              f"kind={r['target_kind']:12} role={r['role'] or '-':10} label={role_label:20} "
              f"pos=({r['local_x_mm']:.2f},{r['local_y_mm']:.2f},{r['local_z_mm']:.2f}) "
              f"rot=({r['local_rx_deg']:.2f},{r['local_ry_deg']:.2f},{r['local_rz_deg']:.2f})")

    # Also check IO-5-850-HP and others
    print()
    for model in ('IO-5-850-HP', 'IO-3-850-HP'):
        rows2 = await c.fetch("""
            SELECT b.id, b.local_rx_deg, b.local_ry_deg, b.local_rz_deg, b.properties
              FROM component_bindings b
              JOIN components c ON c.id = b.component_id
             WHERE c.model = $1 AND c.archived_at IS NULL
               AND b.properties->>'role_label' IN ('front_glan_laser','front_piece','back_glan_laser','back_piece')
             ORDER BY b.properties->>'role_label'
        """, model)
        print(f"\n{model} front/back glan_laser vs piece relative pose:")
        for r in rows2:
            label = (json.loads(r['properties']) if r['properties'] else {}).get('role_label', '?')
            print(f"  {label:20} rot=({r['local_rx_deg']:7.2f},{r['local_ry_deg']:7.2f},{r['local_rz_deg']:7.2f})")
    await c.close()

asyncio.run(main())
