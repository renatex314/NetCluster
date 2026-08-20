-- remove(prefix, dev) -> 1 removed | 0 absent
local dev = ARGV[2]
local rec = redis.call('HMGET', pkey(dev), 'x', 'y', 'tz', 'par')
if not rec[1] then return 0 end
unlink(dev, tonumber(rec[1]), tonumber(rec[2]), tonumber(rec[3]), rec[4])
redis.call('DEL', pkey(dev), ckey(dev))
redis.call('DECR', P .. ':n')
return 1
