local mp = require 'mp'
local utils = require 'mp.utils'
local msg = require 'mp.msg'

local home = os.getenv("HOME") or ""
local opts = {
    language = "ru",
    autoTranslate = false,
    skipLangs = "ru",
    quality = "1080",
    search_limit = "20",
    vot_bin = "/usr/bin/node",
    vot_script = home .. "/.local/share/vot-mpv/vot-translate.js",
}
require('mp.options').read_options(opts, "vot")

-- ISO 639-2 → 639-1 (mpv повертає 3-літерні коди для стрімів)
local lang3to2 = {
    eng="en", rus="ru", zho="zh", kor="ko", lit="lt", lav="lv",
    ara="ar", fra="fr", ita="it", spa="es", deu="de", jpn="ja", kaz="kk",
    ukr="uk", pol="pl", nld="nl", por="pt", tur="tr", swe="sv",
}

local function audio_lang()
    local lang = mp.get_property("current-tracks/audio/lang") or ""
    return lang3to2[lang] or lang
end

local function in_skip_list(lang)
    if lang == "" then return false end
    for skip in opts.skipLangs:gmatch("[^,%s]+") do
        if skip == lang then return true end
    end
    return false
end

local vot_file = nil
local translating = false
local status_timer = nil
local auto_paused = false

local function cleanup()
    if vot_file then
        os.remove(vot_file)
        os.remove(vot_file .. ".status")
        vot_file = nil
    end
    if status_timer then
        status_timer:kill()
        status_timer = nil
    end
    translating = false
    auto_paused = false
end

local function find_vot_track()
    local count = mp.get_property_number("track-list/count") or 0
    for i = 0, count - 1 do
        if mp.get_property("track-list/" .. i .. "/type") == "audio" then
            local title = mp.get_property("track-list/" .. i .. "/title") or ""
            if title:match("^VOT") then
                return mp.get_property_number("track-list/" .. i .. "/id")
            end
        end
    end
    return nil
end

-- Extracts YouTube videoId from URL or local filename like "Title [abc1234xyz].mkv"
local function get_youtube_url(file_path)
    local id = file_path:match("[?&]v=([A-Za-z0-9_%-]+)")
    if id then return file_path end

    id = file_path:match("%[([A-Za-z0-9_%-]+)%][^%[%]]*$")
    if id and #id == 11 then
        return "https://www.youtube.com/watch?v=" .. id
    end

    return nil
end

local function read_status()
    if not vot_file then return end
    local sf = vot_file .. ".status"
    local f = io.open(sf, "r")
    if not f then return end
    local s = f:read("*all")
    f:close()
    if s and s ~= "" then
        mp.osd_message("VOT: " .. s, 3)
    end
end

local function on_done(success, result, err)
    if status_timer then status_timer:kill(); status_timer = nil end
    translating = false

    local function resume_if_paused()
        if auto_paused then
            mp.set_property_bool("pause", false)
            auto_paused = false
        end
    end

    if not success or result.status ~= 0 then
        local stderr = result and result.stderr or err or "?"
        local last_status = ""
        if vot_file then
            local f = io.open(vot_file .. ".status", "r")
            if f then last_status = f:read("*all") or ""; f:close() end
        end
        local show = last_status ~= "" and last_status or stderr:match("[^\n]*$") or "?"
        mp.osd_message("VOT: " .. show, 8)
        msg.error(stderr)
        if vot_file then
            os.remove(vot_file)
            os.remove(vot_file .. ".status")
            vot_file = nil
        end
        resume_if_paused()
        return
    end

    local output = (result.stdout or ""):match("^([^\n]+)")
    if output and output ~= "" then
        local source = output:match("^/") and "кеш" or "сервер"
        mp.commandv("audio-add", output, "select", "VOT " .. opts.language)
        resume_if_paused()
        mp.osd_message("VOT: переклад додано [" .. source .. "]  ←  Ctrl+T щоб вимкнути", 5)
    else
        resume_if_paused()
        mp.osd_message("VOT: не отримано адресу аудіо", 5)
    end
    if vot_file then os.remove(vot_file .. ".status") end
end

local function start_translation(auto_mode)
    local file_path = mp.get_property("path") or ""
    local url = get_youtube_url(file_path)

    if not url then
        mp.osd_message("VOT: потрібне YouTube відео або файл з [videoId] в назві", 4)
        return
    end

    if translating then
        if auto_paused then
            mp.set_property_bool("pause", false)
            auto_paused = false
            mp.osd_message("VOT: відео відновлено (переклад іде в фоні)", 4)
        else
            mp.osd_message("VOT: переклад вже виконується...", 3)
        end
        return
    end

    local old = find_vot_track()
    if old then mp.commandv("audio-remove", old) end
    cleanup()

    -- Pause video if auto-translate and no cached translation
    if auto_mode then
        local vid_id = url:match("[?&]v=([A-Za-z0-9_%-]+)")
        local cache_mp3 = vid_id and (home .. "/.cache/vot/" .. vid_id .. ".mp3") or nil
        if cache_mp3 then
            local f = io.open(cache_mp3, "r")
            if not f then
                mp.set_property_bool("pause", true)
                auto_paused = true
            else
                f:close()
            end
        end
    end

    vot_file = "/tmp/vot_" .. os.time() .. ".mp3"
    translating = true
    mp.osd_message(auto_paused and "VOT: пауза — отримуємо переклад..." or "VOT: запускаємо переклад...", 3)
    msg.info("Running: " .. opts.vot_bin .. " " .. opts.vot_script .. " " .. url)

    status_timer = mp.add_periodic_timer(2, read_status)

    mp.command_native_async({
        name = "subprocess",
        args = { opts.vot_bin, opts.vot_script, url, vot_file, opts.language },
        capture_stdout = true,
        capture_stderr = true,
    }, on_done)
end

local function toggle()
    local track = find_vot_track()
    if track then
        mp.commandv("audio-remove", track)
        cleanup()
        mp.osd_message("VOT: переклад вимкнено", 3)
    elseif translating then
        mp.osd_message("VOT: переклад вже виконується...", 3)
    else
        start_translation(false)
    end
end

mp.add_key_binding(nil, "toggle", toggle)

mp.register_event("file-loaded", function()
    cleanup()
    if opts.autoTranslate then
        if get_youtube_url(mp.get_property("path") or "") then
            local lang = audio_lang()
            if in_skip_list(lang) then
                msg.info("VOT: пропускаємо (" .. lang .. " в skipLangs)")
            else
                start_translation(true)
            end
        end
    end
end)

mp.register_event("shutdown", cleanup)
