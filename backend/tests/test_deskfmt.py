"""Форматы файлов десктопа: комментарии (.cmt) и список передачи (.tsk).
Образцы — синтетические, в точности по структуре реальных файлов CarBUS Analyzer
(строки через CR, ключи Task.* из бинарника)."""
import pytest

from app.deskfmt import format_cmt, format_tsk, parse_cmt, parse_tsk
from app.transmit import task_from_dict

CMT = "\r".join([
    "0000012F=ESC: замок",
    "00000186=Motor: (byte-0) Tacho, 0x20 = 2000 RPM",
    "18DAF110=Диагностика: ответ",
    "000003A5=",
    "",
])

TSK = "\r".join([
    "Task.Begin",
    "Task.Message.Proto=CAN",
    "Task.Message.Channel=1",
    "Task.Message.ExtMsgID=false",
    "Task.Message.RTR=false",
    "Task.Message.MsgID=1EC",
    "Task.Message.DLC=8",
    "Task.Message.Data=0000000000020000",
    "Task.Delay=5",
    "Task.Comment=0x02 - индикатор",
    "Task.Trigger.Trigger=None",
    "Task.Trigger.Delay=0",
    "Task.End",
    "",
    "Task.Begin",
    "Task.Message.Proto=CAN",
    "Task.Message.Channel=2",
    "Task.Message.ExtMsgID=true",
    "Task.Message.RTR=false",
    "Task.Message.MsgID=18DA10F1",
    "Task.Message.DLC=3",
    "Task.Message.Data=023E00",
    "Task.Delay=1000",
    "Task.Comment=",
    "Task.Trigger.Trigger=Single",
    "Task.Trigger.Delay=25",
    "Task.Trigger.Channel=1",
    "Task.Trigger.CodeMsgID=7E8",
    "Task.Trigger.MaskMsgID=7FF",
    "Task.Trigger.DLC=3",
    "Task.Trigger.CodeData=027E000000000000",
    "Task.Trigger.MaskData=FF00FF0000000000",
    "Task.End",
    "",
])


def test_parse_cmt_reads_hex_ids_and_text():
    c = parse_cmt(CMT)
    assert c["303:0"] == "ESC: замок"
    assert c["390:0"] == "Motor: (byte-0) Tacho, 0x20 = 2000 RPM"
    assert c[f"{0x18DAF110}:1"] == "Диагностика: ответ"
    assert f"{0x3A5}:0" not in c          # пустой комментарий не храним


def test_format_cmt_roundtrip_uses_desktop_layout():
    c = parse_cmt(CMT)
    text = format_cmt(c)
    assert "0000012F=ESC: замок\r" in text and "18DAF110=Диагностика: ответ" in text
    assert parse_cmt(text) == c


def test_parse_tsk_reads_tasks_and_triggers():
    tasks = parse_tsk(TSK)
    assert len(tasks) == 2
    a = task_from_dict(tasks[0])
    assert (a.channel, a.can_id, a.ext, a.data, a.period_ms, a.comment) == \
           (1, 0x1EC, False, bytes.fromhex("0000000000020000"), 5, "0x02 - индикатор")
    assert a.trigger.action == "none"
    b = task_from_dict(tasks[1])
    assert (b.channel, b.can_id, b.ext, b.data, b.period_ms) == (2, 0x18DA10F1, True, b"\x02\x3e\x00", 1000)
    tr = b.trigger
    assert (tr.action, tr.delay_ms, tr.channel, tr.can_id, tr.dlc) == ("single", 25, 1, 0x7E8, 3)
    assert tr.data == [0x02, None, 0x00, None, None, None, None, None]


def test_format_tsk_roundtrip():
    tasks = parse_tsk(TSK)
    again = parse_tsk(format_tsk(tasks))
    strip = lambda ts: [{k: v for k, v in t.items() if k != "id"} for t in ts]  # noqa: E731
    assert strip(again) == strip(tasks)
    assert format_tsk(tasks).startswith("Task.Begin\rTask.Message.Proto=CAN\r")


def test_parse_tsk_rejects_garbage():
    with pytest.raises(ValueError):
        parse_tsk("Task.Begin\rTask.Message.MsgID=zz\rTask.End\r")


def test_tsk_trigger_with_29_bit_mask_and_small_id_stays_29_bit():
    text = ("Task.Begin\rTask.Message.Proto=CAN\rTask.Message.Channel=1\rTask.Message.ExtMsgID=false\r"
            "Task.Message.MsgID=100\rTask.Message.DLC=1\rTask.Message.Data=01\rTask.Delay=10\r"
            "Task.Trigger.Trigger=Single\rTask.Trigger.Delay=0\rTask.Trigger.Channel=0\r"
            "Task.Trigger.CodeMsgID=123\rTask.Trigger.MaskMsgID=1FFFFFFF\rTask.Trigger.DLC=\r"
            "Task.Trigger.CodeData=0000000000000000\rTask.Trigger.MaskData=0000000000000000\rTask.End\r")
    t = parse_tsk(text)[0]
    assert t["trigger"]["can_id"] == 0x123 and t["trigger"]["ext"] is True
    task_from_dict(t)
