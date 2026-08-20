-- query(prefix, x0, y0, x1, y1, zoom, limit) -> flat {id, count, cx, cy, ...}
--
-- Top-down: roots come from the level-0 grid (<= 164 cells for the whole world),
-- then we walk children whose level is <= z. A subtree is pruned when the ball
-- B(c, 2 r_tz) -- which provably contains every descendant -- misses the box, so
-- the work is proportional to the clusters returned, not to the point count.
local x0, y0 = tonumber(ARGV[2]), tonumber(ARGV[3])
local x1, y1 = tonumber(ARGV[4]), tonumber(ARGV[5])
local z = tonumber(ARGV[6])
local limit = tonumber(ARGV[7])
if z > MAXZ then z = MAXZ end
if z < 0 then z = 0 end

local out, n = {}, 0
local stack, top = {}, 0
local cs, pad0 = CS[0], 2 * R[0]
local cx0 = math.floor((x0 - pad0) / cs); if cx0 < 0 then cx0 = 0 end
local cy0 = math.floor((y0 - pad0) / cs); if cy0 < 0 then cy0 = 0 end
local cx1 = math.floor((x1 + pad0) / cs)
local cy1 = math.floor((y1 + pad0) / cs)
for cx = cx0, cx1 do
  for cy = cy0, cy1 do
    local h = redis.call('HGETALL', gkey(0, cx, cy))
    for i = 1, #h, 2 do top = top + 1; stack[top] = h[i] end
  end
end

while top > 0 do
  local s = stack[top]; top = top - 1
  local rec = redis.call('HMGET', pkey(s), 'x', 'y', 'tz', 'cnt', 'sx', 'sy')
  local px, py, tz = tonumber(rec[1]), tonumber(rec[2]), tonumber(rec[3])
  local pad = 2 * R[tz]
  if px >= x0 - pad and px <= x1 + pad and py >= y0 - pad and py <= y1 + pad then
    local c, sx, sy = tonumber(rec[4]), tonumber(rec[5]), tonumber(rec[6])
    local kids = redis.call('ZRANGEBYSCORE', ckey(s), '-inf', z)
    for i = 1, #kids do
      local kr = redis.call('HMGET', pkey(kids[i]), 'cnt', 'sx', 'sy')
      c = c - tonumber(kr[1]); sx = sx - tonumber(kr[2]); sy = sy - tonumber(kr[3])
      top = top + 1; stack[top] = kids[i]
    end
    local mx, my = sx / c, sy / c
    if mx >= x0 and mx <= x1 and my >= y0 and my <= y1 then
      out[n + 1] = s
      out[n + 2] = c
      out[n + 3] = math.floor(mx + 0.5)
      out[n + 4] = math.floor(my + 0.5)
      n = n + 4
      if n >= limit * 4 then break end
    end
  end
end
return out
