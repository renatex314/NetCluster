-- rep(prefix, dev, zoom) -> the id of the cluster this device is drawn as at `zoom`
local dev = ARGV[2]
local z = tonumber(ARGV[3])
local guard = 0
while true do
  local tz = tonumber(redis.call('HGET', pkey(dev), 'tz'))
  if tz == nil then return nil end
  if tz <= z then return dev end
  dev = redis.call('HGET', pkey(dev), 'par')
  guard = guard + 1
  if guard > 64 then error('netcluster: parent cycle') end
end
