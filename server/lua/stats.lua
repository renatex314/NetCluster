-- stats(prefix) -> flat {count, levelHistogram...} for the debug endpoint
local n = redis.call('GET', P .. ':n') or '0'
local out = { n }
for z = 0, MAXZ do
  local c = 0
  local cur = '0'
  repeat
    local r = redis.call('SCAN', cur, 'MATCH', P .. ':g:' .. fmt(z) .. ':*', 'COUNT', 500)
    cur = r[1]
    for i = 1, #r[2] do c = c + redis.call('HLEN', r[2][i]) end
  until cur == '0'
  out[#out + 1] = c
end
return out
