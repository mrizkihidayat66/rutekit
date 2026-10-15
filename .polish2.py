import io

OPENAI = chr(79) + chr(112) + chr(101) + chr(110) + chr(65) + chr(73)

# PRD: anchor past the product-name token, which Read renders as four characters.
p = 'docs/plan/PRD.md'
t = io.open(p, encoding='utf-8').read()
old_tail = (' endpoint that aggregates many AI provider accounts behind it. It unifies the most '
            'complete provider catalog, the most mature account automation, rich pool tooling, and '
            'the strongest UI/UX craft — rebuilt end-to-end in TypeScript.')
new_tail = (' endpoint that\naggregates many AI provider accounts behind it. Four things carry the weight: a declarative\n'
            'provider catalog, account automation that can sign in and import in bulk, an account pool\n'
            'with quota tracking, and a console built on one styling strategy — all end to end in\n'
            'TypeScript.')
if old_tail in t:
    io.open(p, 'w', encoding='utf-8', newline='').write(t.replace(old_tail, new_tail, 1))
    print('PRD superlatives: fixed')
else:
    print('PRD: anchor still missing')
    for line in t.split('\n')[:14]:
        if 'unifies' in line or 'aggregates' in line:
            print('   ', ascii(line[:160]))

# ROADMAP: show what the GATE C block says now.
p2 = 'docs/plan/ROADMAP.md'
t2 = io.open(p2, encoding='utf-8').read()
i = t2.find('GATE C status')
print()
print('--- current GATE C block ---')
print(t2[i - 4:i + 1100] if i != -1 else 'not found')
