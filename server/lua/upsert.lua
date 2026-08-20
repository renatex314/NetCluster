-- upsert(prefix, dev, x, y) -> 0 unchanged | 1 inserted | 2 moved | 3 moved+repaired
local dev = ARGV[2]
local x, y = tonumber(ARGV[3]), tonumber(ARGV[4])
local rec = redis.call('HMGET', pkey(dev), 'x', 'y', 'tz', 'par')

if not rec[1] then
  redis.call('HSET', pkey(dev), 'x', fmt(x), 'y', fmt(y), 'cnt', '1', 'sx', fmt(x), 'sy', fmt(y))
  link(dev, x, y, '1', fmt(x), fmt(y), MAXZ)
  redis.call('INCR', P .. ':n')
  return 1
end

local ox, oy = tonumber(rec[1]), tonumber(rec[2])
if ox == x and oy == y then return 0 end
local t, par = tonumber(rec[3]), rec[4]
local ok = true

-- (B) separation: dev belongs to C_z for every z >= t, so nothing may have come
-- within r_z at any of those levels. Leaves (t == LEAF) carry no such constraint.
if t <= MAXZ then
  local lvl = findCover(x, y, dev, MAXZ, t)
  if lvl ~= nil then ok = false end
end
-- (C) still covered by our parent, within the hysteresis band
if ok and par ~= '' then
  local pr = redis.call('HMGET', pkey(par), 'x', 'y')
  local dx, dy = tonumber(pr[1]) - x, tonumber(pr[2]) - y
  if dx * dx + dy * dy > HY2[t - 1] then ok = false end
end
-- (C) do we still cover our own children?
if ok then
  local kids = redis.call('ZRANGE', ckey(dev), 0, -1, 'WITHSCORES')
  for i = 1, #kids, 2 do
    local kr = redis.call('HMGET', pkey(kids[i]), 'x', 'y')
    local dx, dy = tonumber(kr[1]) - x, tonumber(kr[2]) - y
    if dx * dx + dy * dy > HY2[tonumber(kids[i + 1]) - 1] then ok = false break end
  end
end

if ok then
  gridMove(dev, t, ox, oy, x, y)
  redis.call('HSET', pkey(dev), 'x', fmt(x), 'y', fmt(y))
  aggUp(dev, '0', fmt(x - ox), fmt(y - oy))
  return 2
end

unlink(dev, ox, oy, t, par)
redis.call('HSET', pkey(dev), 'x', fmt(x), 'y', fmt(y), 'cnt', '1', 'sx', fmt(x), 'sy', fmt(y))
link(dev, x, y, '1', fmt(x), fmt(y), MAXZ)
return 3
