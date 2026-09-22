import { describe, expect, it } from "vitest";
import { normaliseApaar, normalisePhone, parseRoster } from "@/core/roster/parse";

describe("normalisePhone", () => {
  it("accepts the shapes people actually paste", () => {
    for (const input of [
      "9876543210",
      "+91 98765 43210",
      "+919876543210",
      "0091-9876543210",
      "09876543210",
      "98765-43210",
      " 98765 43210 ",
    ]) {
      expect(normalisePhone(input), input).toBe("9876543210");
    }
  });

  it("rejects numbers no OTP will ever reach", () => {
    // Storing these is worse than rejecting them: the student appears set up
    // and then cannot sign in on test day.
    expect(normalisePhone("12345")).toBeNull();
    expect(normalisePhone("1234567890")).toBeNull(); // no Indian mobile starts with 1
    expect(normalisePhone("5876543210")).toBeNull();
    expect(normalisePhone("")).toBeNull();
    expect(normalisePhone("not a phone")).toBeNull();
  });

  it("rejects a long number whose extra digits are not a real prefix", () => {
    expect(normalisePhone("12349876543210")).toBeNull();
  });
});

describe("parseRoster — pasted lists", () => {
  it("takes a plain list of names", () => {
    const result = parseRoster("Arun Kumar\nMeera Nair\nRavi Shankar");
    expect(result.students.map((s) => s.fullName)).toEqual([
      "Arun Kumar",
      "Meera Nair",
      "Ravi Shankar",
    ]);
    expect(result.problems).toEqual([]);
  });

  it("strips numbering a teacher pasted with the list", () => {
    const result = parseRoster("1. Arun Kumar\n2) Meera Nair\n3 - Ravi Shankar");
    expect(result.students.map((s) => s.fullName)).toEqual([
      "Arun Kumar",
      "Meera Nair",
      "Ravi Shankar",
    ]);
  });

  it("ignores blank lines and stray whitespace", () => {
    const result = parseRoster("\n  Arun Kumar  \n\n\nMeera Nair\n  \n");
    expect(result.students).toHaveLength(2);
  });

  it("collapses runs of spaces inside a name", () => {
    expect(parseRoster("Arun    Kumar").students[0]?.fullName).toBe("Arun Kumar");
  });

  it("does not treat a comma inside one name as a delimiter", () => {
    // One row with a comma is not a CSV. Getting this wrong turns a name into
    // a name plus a phantom roll number.
    const result = parseRoster("Arun Kumar\nNair, Meera\nRavi Shankar");
    expect(result.students).toHaveLength(3);
    expect(result.students[1]?.fullName).toBe("Nair, Meera");
  });
});

describe("parseRoster — CSV", () => {
  it("reads a header and maps columns by name", () => {
    const result = parseRoster(
      "Name,Roll No,Phone\nArun Kumar,12,9876543210\nMeera Nair,13,9812345678",
    );
    expect(result.detected.hadHeader).toBe(true);
    expect(result.students).toHaveLength(2);
    expect(result.students[0]).toMatchObject({
      fullName: "Arun Kumar",
      rollNumber: "12",
      phone: "9876543210",
    });
  });

  it("maps columns in any order", () => {
    const result = parseRoster(
      "Mobile,Student Name,Roll\n9876543210,Arun Kumar,12",
    );
    expect(result.students[0]).toMatchObject({
      fullName: "Arun Kumar",
      rollNumber: "12",
      phone: "9876543210",
    });
  });

  it("assumes name, roll, phone order when there is no header", () => {
    const result = parseRoster("Arun Kumar,12,9876543210");
    expect(result.detected.hadHeader).toBe(false);
    expect(result.students[0]).toMatchObject({
      fullName: "Arun Kumar",
      rollNumber: "12",
      phone: "9876543210",
    });
  });

  it("honours quoted cells so a comma in a name survives", () => {
    const result = parseRoster('Name,Roll\n"Kumar, Arun",12');
    expect(result.students[0]?.fullName).toBe("Kumar, Arun");
    expect(result.students[0]?.rollNumber).toBe("12");
  });

  it("reads tab-separated text pasted from a spreadsheet", () => {
    const result = parseRoster("Name\tRoll\tPhone\nArun Kumar\t12\t9876543210");
    expect(result.detected.delimiter).toBe("\t");
    expect(result.students[0]?.phone).toBe("9876543210");
  });

  it("reports line numbers as the teacher's own file numbers them", () => {
    const result = parseRoster("Name,Roll\nArun Kumar,12\n,13");
    expect(result.problems[0]?.line).toBe(3);
  });
});

describe("parseRoster — imperfect data", () => {
  it("keeps the student when the phone is unusable, and says so", () => {
    // A bad phone is not a reason to lose a name.
    const result = parseRoster("Name,Phone\nArun Kumar,12345");
    expect(result.students).toHaveLength(1);
    expect(result.students[0]?.phone).toBeUndefined();
    expect(result.problems[0]?.message).toMatch(/still added/);
  });

  it("reports a row with no name and drops only that row", () => {
    const result = parseRoster("Name,Roll\nArun Kumar,12\n,13\nMeera Nair,14");
    expect(result.students).toHaveLength(2);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.message).toMatch(/No name/);
  });

  it("catches a header row the detector missed", () => {
    const result = parseRoster("Arun Kumar\nName\nMeera Nair");
    expect(result.students).toHaveLength(2);
    expect(result.problems[0]?.message).toMatch(/header row/);
  });

  it("does not turn a phone number in the roll column into a roll number", () => {
    const result = parseRoster("Arun Kumar,9876543210");
    expect(result.students[0]?.rollNumber).toBeUndefined();
  });

  it("flags duplicates within the list itself", () => {
    const result = parseRoster("Arun Kumar\nMeera Nair\narun kumar");
    expect(result.duplicateNames).toContain("arun kumar");
    // Still imported — the teacher decides whether two students share a name.
    expect(result.students).toHaveLength(3);
  });

  it("stops at 500 rows and says why", () => {
    const many = Array.from({ length: 520 }, (_, i) => `Student ${i}`).join("\n");
    const result = parseRoster(many);
    expect(result.students).toHaveLength(500);
    expect(result.problems.at(-1)?.message).toMatch(/500 rows/);
  });

  it("returns empty for empty input rather than throwing", () => {
    const result = parseRoster("");
    expect(result.students).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it("rejects an absurdly long name", () => {
    const result = parseRoster("x".repeat(200));
    expect(result.students).toHaveLength(0);
    expect(result.problems[0]?.message).toMatch(/too long/);
  });
});

describe("parseRoster — mixed lists", () => {
  it("splits a trailing number off a name even when other lines have none", () => {
    // The shape teachers actually paste: roll numbers for the students they
    // remember, bare names for the rest. The delimiter detector refuses a
    // mixed list, so this is handled per line.
    const result = parseRoster("Arun Kumar\nMeera Nair, 12\nRavi Shankar");
    expect(result.students).toHaveLength(3);
    expect(result.students[1]).toMatchObject({
      fullName: "Meera Nair",
      rollNumber: "12",
    });
    expect(result.students[0]?.rollNumber).toBeUndefined();
  });

  it("reads a trailing ten-digit number as a phone, not a roll number", () => {
    const result = parseRoster("Arun Kumar\nMeera Nair, 9876543210");
    expect(result.students[1]).toMatchObject({
      fullName: "Meera Nair",
      phone: "9876543210",
    });
    expect(result.students[1]?.rollNumber).toBeUndefined();
  });

  it("still refuses to split a name that merely contains a comma", () => {
    // "Nair, Meera" is a name written surname-first. Splitting it would file
    // the student under the wrong name, which is worse than missing a roll.
    const result = parseRoster("Arun Kumar\nNair, Meera\nRavi Shankar");
    expect(result.students[1]?.fullName).toBe("Nair, Meera");
    expect(result.students[1]?.rollNumber).toBeUndefined();
  });

  it("takes the phone AND the roll off a line when other lines have no comma", () => {
    // The lazy match used to stop at the LAST comma, leaving the phone inside
    // the name: "Zoë D'Souza-Ñ, 9379778877" with roll 7.
    const result = parseRoster("Arun Kumar\nZoë D'Souza-Ñ, 9379778877, 7\nRavi Shankar");
    expect(result.students[1]).toMatchObject({
      fullName: "Zoë D'Souza-Ñ",
      phone: "9379778877",
      rollNumber: "7",
    });
  });

  it("keeps a surname-first name whole while splitting its roll", () => {
    const result = parseRoster("Arun Kumar\nNair, Meera, 12\nRavi Shankar");
    expect(result.students[1]).toMatchObject({ fullName: "Nair, Meera", rollNumber: "12" });
  });

  it("strips separators left by an empty last column", () => {
    const result = parseRoster("Arun Kumar\nMeera Nair,,");
    expect(result.students[1]?.fullName).toBe("Meera Nair");
  });
});

describe("parseRoster — which column is the phone", () => {
  it("reads a two-column list as name and phone, not name and roll", () => {
    // The bug this locks down: with a fixed name/roll/phone order, the number
    // in "Arun Kumar, 9876543210" landed in the roll column, was rejected there
    // for looking like a phone, and vanished. The student imported cleanly with
    // no phone and no warning — and could then never sign in, because a phone
    // number is the only thing a student signs in with.
    const result = parseRoster("Arun Kumar, 9876543210");
    expect(result.students[0]?.phone).toBe("9876543210");
    expect(result.students[0]?.rollNumber).toBeUndefined();
    expect(result.problems).toEqual([]);
  });

  it("still reads a short number as a roll number", () => {
    const result = parseRoster("Arun Kumar, 12\nMeera Nair, 13");
    expect(result.students[0]?.rollNumber).toBe("12");
    expect(result.students[0]?.phone).toBeUndefined();
  });

  it("keeps name, roll and phone in a three-column list", () => {
    const result = parseRoster(
      "Arun Kumar, 12, 9876543210\nMeera Nair, 13, 9876543211",
    );
    expect(result.students[0]?.rollNumber).toBe("12");
    expect(result.students[0]?.phone).toBe("9876543210");
  });

  it("finds the phone column when it comes before the roll", () => {
    const result = parseRoster(
      "Arun Kumar, 9876543210, 12\nMeera Nair, 9876543211, 13",
    );
    expect(result.students[0]?.phone).toBe("9876543210");
    expect(result.students[0]?.rollNumber).toBe("12");
  });

  it("does not move the column because one number is missing", () => {
    // A majority decides. One blank or mistyped number in a class of thirty is
    // normal, and must not reclassify everybody else's phone as a roll number.
    const result = parseRoster(
      "Arun Kumar, 9876543210\nMeera Nair,\nRavi Shankar, 9876543212",
    );
    expect(result.students[0]?.phone).toBe("9876543210");
    expect(result.students[1]?.phone).toBeUndefined();
    expect(result.students[2]?.phone).toBe("9876543212");
  });

  it("reads the header our own sample template produces", () => {
    // "Mobile Number" did not exact-match "mobile", so every phone in the file
    // we hand teachers ourselves was dropped with nothing said.
    const result = parseRoster(
      "Full Name,Mobile Number,Roll Number\nArun Kumar,9876543210,12\nMeera Nair,9812345678,13",
    );
    expect(result.detected.hadHeader).toBe(true);
    expect(result.students[0]).toMatchObject({
      fullName: "Arun Kumar",
      phone: "9876543210",
      rollNumber: "12",
    });
    expect(result.problems).toEqual([]);
  });

  it("reads the sample template's empty APAAR column without a problem", () => {
    const result = parseRoster(
      "Full Name,Mobile Number,Roll Number,APAAR ID\nSample Student One,,101,\nSample Student Two,,102,",
    );
    expect(result.students).toHaveLength(2);
    expect(result.students[0]?.apaarId).toBeUndefined();
    expect(result.problems).toEqual([]);
  });

  it.each([
    ["Student Name", "Phone Number", "Roll No"],
    ["Name", "Mobile No.", "Roll no"],
    ["NAME", "Contact No", "Roll"],
    ["Student", "Contact Number", "Admission No"],
  ])("maps header variants %s / %s / %s", (name, phone, roll) => {
    const result = parseRoster(`${name},${phone},${roll}\nArun Kumar,+91 98765 43210,7`);
    expect(result.students[0]).toMatchObject({
      fullName: "Arun Kumar",
      phone: "9876543210",
      rollNumber: "7",
    });
  });

  it("does not mistake a first student whose name starts like a header for one", () => {
    const result = parseRoster("Nameeta Rao\nCellina D'Cruz\nRollo Mathew");
    expect(result.detected.hadHeader).toBe(false);
    expect(result.students).toHaveLength(3);
  });

  it("says so when a header names no phone column but a column is full of phones", () => {
    const result = parseRoster(
      "Name,Parent,Roll\nArun Kumar,9876543210,12\nMeera Nair,9812345678,13",
    );
    expect(result.students[0]?.phone).toBe("9876543210");
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.message).toMatch(/Mobile/);
  });

  it("still trusts an explicit header over the content", () => {
    const result = parseRoster("Name, Phone, Roll\nArun Kumar, 9876543210, 12");
    expect(result.students[0]?.phone).toBe("9876543210");
    expect(result.students[0]?.rollNumber).toBe("12");
  });
});

describe("APAAR IDs", () => {
  it("normalises the printed grouping to twelve digits", () => {
    expect(normaliseApaar("1234 5678 9012")).toBe("123456789012");
    expect(normaliseApaar("1234-5678-9012")).toBe("123456789012");
    expect(normaliseApaar(" 123456789012 ")).toBe("123456789012");
  });

  it("refuses anything that is not exactly twelve digits", () => {
    expect(normaliseApaar("12345678901")).toBeNull();
    expect(normaliseApaar("1234567890123")).toBeNull();
    expect(normaliseApaar("12345678901A")).toBeNull();
    expect(normaliseApaar("")).toBeNull();
  });

  it.each(["APAAR", "APAAR ID", "Apaar No", "APAAR Number", "ABC ID"])(
    "reads a %s column, and it does not become the roll number",
    (heading) => {
      const result = parseRoster(`Name,Roll No,${heading}\nArun Kumar,12,1234 5678 9012`);
      expect(result.students[0]).toMatchObject({ rollNumber: "12", apaarId: "123456789012" });
      expect(result.students[0]?.phone).toBeUndefined();
    },
  );

  it("adds the student without it when the ID is malformed, and says so", () => {
    const result = parseRoster("Name,APAAR ID\nArun Kumar,12345");
    expect(result.students[0]?.fullName).toBe("Arun Kumar");
    expect(result.students[0]?.apaarId).toBeUndefined();
    expect(result.problems[0]?.message).toMatch(/12-digit APAAR ID/);
  });

  it("never guesses an APAAR column without a header", () => {
    // Twelve digits with no header is ambiguous; it is not stored as an APAAR ID.
    const result = parseRoster("Arun Kumar, 123456789012");
    expect(result.students[0]?.apaarId).toBeUndefined();
  });
});
