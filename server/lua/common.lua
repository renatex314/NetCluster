-- netcluster / Redis -- shared preamble.
--
-- The whole net hierarchy lives in Redis; Node processes hold nothing. Every
-- mutation runs inside one script because the invariants span keys: two pods
-- moving devices in the same neighbourhood would otherwise both observe "no
-- centre within r_z" and both promote, breaking separation permanently. Redis
-- runs scripts atomically, so a script is the unit of consistency here.
--
-- Keys (prefix P, default "nc"):
--   P:cfg              HASH  radius, extent, maxZoom, hyst   (geometry, shared by all pods)
--   P:p:<dev>          HASH  x y tz par cnt sx sy
--   P:c:<dev>          ZSET  children, score = child's tz (so "children with tz <= z"
--                            is one ZRANGEBYSCORE, and they arrive level-ordered)
--   P:g:<z>:<cx>:<cy>  HASH  dev -> "x,y" for every centre of C_z in that cell
--   P:n                STRING  live point count
--
-- The grid cell stores the position alongside the id so a neighbourhood scan is
-- one HGETALL instead of one HMGET per candidate.
--
-- NUMERIC RULE, do not break it: Lua 5.1 renders numbers with %.14g, so
-- tostring(1073741824000000) is "1.073741824e+15" and would corrupt an
-- aggregate. Coordinate sums are moved as *strings* straight from HGET into
-- HINCRBY (Redis parses them as int64), and negated textually by neg().
-- Anything else integer-valued goes through fmt().

local P = ARGV[1]
local PREC = 1073741824              -- 2^30 fixed-point world units

local cfg = redis.call('HMGET', P .. ':cfg', 'radius', 'extent', 'maxZoom', 'hyst')
if not cfg[1] then return redis.error_reply('netcluster: index not configured (call init first)') end
local RADIUS, EXTENT = tonumber(cfg[1]), tonumber(cfg[2])
local MAXZ, HYST = tonumber(cfg[3]), tonumber(cfg[4])
local LEAF = MAXZ + 1

local R, R2, CS, HY2 = {}, {}, {}, {}
for z = 0, MAXZ do
  R[z] = PREC * RADIUS / (EXTENT * 2 ^ z)
  R2[z] = R[z] * R[z]
  CS[z] = 2 * R[z]                   -- cell side: query ball spans <= 2 cells/axis
  local h = R[z] * (1 + HYST)
  HY2[z] = h * h
end
R[LEAF] = -1; R2[LEAF] = -1; HY2[LEAF] = -1

local function fmt(n) return string.format('%d', n) end
local function neg(s)
  if string.sub(s, 1, 1) == '-' then return string.sub(s, 2) end
  return '-' .. s
end
local function pkey(d) return P .. ':p:' .. d end
local function ckey(d) return P .. ':c:' .. d end
local function gkey(z, cx, cy) return P .. ':g:' .. fmt(z) .. ':' .. fmt(cx) .. ':' .. fmt(cy) end
local function xystr(x, y) return fmt(x) .. ',' .. fmt(y) end
local function parsexy(s)
  local c = string.find(s, ',', 1, true)
  return tonumber(string.sub(s, 1, c - 1)), tonumber(string.sub(s, c + 1))
end

-- Finest level in [downTo, from] at which some centre of C_z (other than
-- `exclude`) lies within r_z of (x,y). Returns level, id -- or nil.
-- Ties break on id so the result never depends on hash iteration order.
local function findCover(x, y, exclude, from, downTo)
  for z = from, downTo, -1 do
    local r, r2, cs = R[z], R2[z], CS[z]
    local cx0, cx1 = math.floor((x - r) / cs), math.floor((x + r) / cs)
    local cy0, cy1 = math.floor((y - r) / cs), math.floor((y + r) / cs)
    if cx0 < 0 then cx0 = 0 end
    if cy0 < 0 then cy0 = 0 end
    local bd, bid = nil, nil
    for cx = cx0, cx1 do
      for cy = cy0, cy1 do
        local h = redis.call('HGETALL', gkey(z, cx, cy))
        for i = 1, #h, 2 do
          local id = h[i]
          if id ~= exclude then
            local px, py = parsexy(h[i + 1])
            local dx, dy = px - x, py - y
            local d2 = dx * dx + dy * dy
            if d2 <= r2 and (bd == nil or d2 < bd or (d2 == bd and id < bid)) then
              bd, bid = d2, id
            end
          end
        end
      end
    end
    if bid then return z, bid end
  end
  return nil, nil
end

-- List `dev` in the grid of every level from tz down to maxZoom.
local function gridAdd(dev, tz, x, y)
  if tz > MAXZ then return end
  local cs = CS[MAXZ]
  local cx, cy = math.floor(x / cs), math.floor(y / cs)
  local xy = xystr(x, y)
  for z = MAXZ, tz, -1 do
    redis.call('HSET', gkey(z, cx, cy), dev, xy)
    cx = math.floor(cx / 2); cy = math.floor(cy / 2)
  end
end

local function gridDel(dev, tz, x, y)
  if tz > MAXZ then return end
  local cs = CS[MAXZ]
  local cx, cy = math.floor(x / cs), math.floor(y / cs)
  for z = MAXZ, tz, -1 do
    redis.call('HDEL', gkey(z, cx, cy), dev)
    cx = math.floor(cx / 2); cy = math.floor(cy / 2)
  end
end

-- Reposition a listed centre. Cells are dyadic, so a coarse cell index is the
-- fine one shifted right; the stored position still has to be refreshed at
-- every level the device is listed at.
local function gridMove(dev, tz, ox, oy, nx, ny)
  if tz > MAXZ then return end
  local cs = CS[MAXZ]
  local ocx, ocy = math.floor(ox / cs), math.floor(oy / cs)
  local ncx, ncy = math.floor(nx / cs), math.floor(ny / cs)
  local xy = xystr(nx, ny)
  for z = MAXZ, tz, -1 do
    if ocx ~= ncx or ocy ~= ncy then redis.call('HDEL', gkey(z, ocx, ocy), dev) end
    redis.call('HSET', gkey(z, ncx, ncy), dev, xy)
    ocx = math.floor(ocx / 2); ocy = math.floor(ocy / 2)
    ncx = math.floor(ncx / 2); ncy = math.floor(ncy / 2)
  end
end

-- Add (dc, dx, dy) to `dev` and every ancestor. Deltas are STRINGS: see the
-- numeric rule above.
local function aggUp(dev, dc, dx, dy)
  local guard = 0
  while dev and dev ~= '' do
    local k = pkey(dev)
    if dc ~= '0' then redis.call('HINCRBY', k, 'cnt', dc) end
    if dx ~= '0' then redis.call('HINCRBY', k, 'sx', dx) end
    if dy ~= '0' then redis.call('HINCRBY', k, 'sy', dy) end
    dev = redis.call('HGET', k, 'par')
    guard = guard + 1
    if guard > 64 then error('netcluster: parent cycle at ' .. tostring(dev)) end
  end
end

-- Place a positioned, already-aggregated device into the hierarchy.
-- `from` caps the sweep: a re-homed orphan that did not move can only get
-- coarser, so levels finer than its old level cannot produce a hit.
local function link(dev, x, y, cnt, sx, sy, from)
  local z, par = findCover(x, y, dev, from, 0)
  local tz = (z == nil) and 0 or (z + 1)
  redis.call('HSET', pkey(dev), 'tz', fmt(tz), 'par', par or '')
  gridAdd(dev, tz, x, y)
  if par then
    redis.call('ZADD', ckey(par), tz, dev)
    aggUp(par, cnt, sx, sy)
  end
  return tz
end

-- Detach `dev`, re-homing its children. Leaves p:dev holding only its own mass;
-- the caller then deletes it or links it back at a new position.
local function unlink(dev, x, y, tz, par)
  gridDel(dev, tz, x, y)                       -- must vanish before re-homing
  aggUp(par, '-1', neg(fmt(x)), neg(fmt(y)))
  local kids = redis.call('ZRANGE', ckey(dev), 0, -1)
  for i = 1, #kids do
    local kid = kids[i]
    local kr = redis.call('HMGET', pkey(kid), 'x', 'y', 'tz', 'cnt', 'sx', 'sy')
    local kx, ky, ktz = tonumber(kr[1]), tonumber(kr[2]), tonumber(kr[3])
    aggUp(par, neg(kr[4]), neg(kr[5]), neg(kr[6]))
    redis.call('ZREM', ckey(dev), kid)
    gridDel(kid, ktz, kx, ky)
    link(kid, kx, ky, kr[4], kr[5], kr[6], ktz - 1)
  end
  redis.call('DEL', ckey(dev))
  if par and par ~= '' then redis.call('ZREM', ckey(par), dev) end
  redis.call('HSET', pkey(dev), 'cnt', '1', 'sx', fmt(x), 'sy', fmt(y))
end

-- Aggregate of the cluster represented by `dev` at level z:
-- its subtree minus the subtrees of children that have already split off.
local function clusterAt(dev, z)
  local rec = redis.call('HMGET', pkey(dev), 'cnt', 'sx', 'sy')
  local c, sx, sy = tonumber(rec[1]), tonumber(rec[2]), tonumber(rec[3])
  local kids = redis.call('ZRANGEBYSCORE', ckey(dev), '-inf', z)
  for i = 1, #kids do
    local kr = redis.call('HMGET', pkey(kids[i]), 'cnt', 'sx', 'sy')
    c = c - tonumber(kr[1]); sx = sx - tonumber(kr[2]); sy = sy - tonumber(kr[3])
  end
  return c, sx, sy
end
