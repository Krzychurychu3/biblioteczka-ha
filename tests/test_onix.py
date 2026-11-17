"""Testy parsera ONIX 3.0 (e-ISBN) na prawdziwych odpowiedziach i plikach syntetycznych."""

import pytest

from conftest import FIXTURES_DIR

from biblioteczka.lookup import onix

try:
    from biblioteczka.isbn import ISBN

    def make_isbn(text):
        return ISBN.parse(text)

except ImportError:  # moduł isbn pisany równolegle – prywatny dubler na potrzeby testów
    from dataclasses import dataclass

    @dataclass(frozen=True)
    class _IsbnDouble:
        digits: str
        isbn10: object = None

    def make_isbn(text):
        return _IsbnDouble(text)


EISBN = FIXTURES_DIR / "eisbn"
NS = 'xmlns="http://ns.editeur.org/onix/3.0/reference"'


def parse_file(name, isbn="9788375780635"):
    return onix.parse((EISBN / name).read_bytes(), make_isbn(isbn))


def parse_xml(body, isbn="9788375780635"):
    xml = f'<?xml version="1.0" encoding="UTF-8"?><ONIXMessage release="3.0" {NS}>{body}</ONIXMessage>'
    return onix.parse(xml.encode("utf-8"), make_isbn(isbn))


def product(descriptive="", publishing=""):
    return (
        "<Product><DescriptiveDetail>"
        "<TitleDetail><TitleElement><TitleText>Tytuł</TitleText></TitleElement></TitleDetail>"
        f"{descriptive}</DescriptiveDetail><PublishingDetail>{publishing}</PublishingDetail></Product>"
    )


def summary(info):
    return (
        info.title,
        info.author_name,
        info.series_name,
        info.is_series_certain,
        info.volume_number,
        info.publisher,
        info.year,
        info.page_count,
    )


REAL = [
    (
        "9788380083738.xml",
        # ImprintName trafia bez porządkowania (jak w iOS), stąd przecinek; data roli 09 → rok 2018.
        ("Harry Potter i więzień Azkabanu", "J. K Rowling", None, False, None, "Media Rodzina,", 2018, None),
    ),
    (
        "9788382400076.xml",
        ("Tomek Łebski ma (chrapkę na) smakołyki", "Liz Pichon", None, False, None, "Wydawnictwo Zielona Sowa", 2021, None),
    ),
    (
        "9788372788313.xml",
        # PersonNameInverted bez przecinka zostaje bez zmian.
        ("Kicia Kocia nie może zasnąć", "Anita Głowińska", None, False, None, "Media Rodzina", 2013, None),
    ),
    (
        "9788328721166.xml",
        ("Tomek na Czarnym Lądzie", None, None, False, None, "Muza,", 2021, None),
    ),
]


@pytest.mark.parametrize(("name", "expected"), REAL, ids=[r[0] for r in REAL])
def test_real_responses(name, expected):
    info = parse_file(name, name[:13])
    assert info is not None
    assert summary(info) == expected
    assert info.sources == ["e-ISBN"]


@pytest.mark.parametrize(
    "name",
    [
        "9788375780635.xml",
        "9788372780140.xml",
        "9788310139658.xml",
        "9788308060254.xml",
        "9788308060162.xml",
        "9788386530144.xml",
        "9788385841081.xml",
        "9781593279509.xml",
        "9780140328721.xml",
        "9788399999990.xml",
    ],
)
def test_header_without_product_is_not_found(name):
    assert parse_file(name, name[:13]) is None


def test_fixture_headers_carry_no_personal_contact_data():
    for path in EISBN.glob("*.xml"):
        text = path.read_text(encoding="utf-8")
        assert "bn.org.pl</EmailAddress>" not in text
        assert "+48226" not in text


def test_spec_example_collection_title_prefix_contributors_extents_dates():
    info = parse_file("synthetic-collection-extent.xml")
    # PartNumber z Collection przychodzi pierwszy i wygrywa; A01 wewnątrz Collection go nie ma.
    assert summary(info) == ("The Hobbit", "J. R. R. Tolkien", "Pucio", True, 7, "„Iskry”", 2013, 320)


def test_quirks_fixture():
    info = parse_file("synthetic-quirks.xml")
    assert info.title == "Zażółć gęślą jaźń & inne"
    # Puste PersonName nie blokuje kolejnego autora (poprawka §9.5).
    assert info.author_name == "Jan Kowalski"
    # „©” po uporządkowaniu jest pusty → brak wydawcy, a nie pusty tekst.
    assert info.publisher is None
    # Rok spoza 1500…2100 pomijany; późniejsza data innej roli niż 01 nie nadpisuje.
    assert info.year == 2010
    # Strony z drugiego produktu: „ok. 100” to nie liczba, 128 (po obcięciu spacji) tak.
    assert info.page_count == 128
    assert info.series_name is None


def test_mixed_content_keeps_only_the_trailing_text():
    info = parse_xml(product(publishing='<Imprint><ImprintName>Wydawnictwo <B>x</B> "Znak" </ImprintName></Imprint>'))
    assert info.publisher == '"Znak"'


def test_malformed_xml_gives_none_even_with_a_product():
    assert parse_file("synthetic-malformed.xml") is None
    assert onix.parse(b"", make_isbn("9788375780635")) is None
    assert onix.parse(b"<html><body>502 Bad Gateway</body></html>", make_isbn("9788375780635")) is None
    assert onix.parse(b"\x00\x01", make_isbn("9788375780635")) is None


def test_product_without_title_gives_none():
    assert parse_xml("<Product><DescriptiveDetail></DescriptiveDetail></Product>") is None
    assert parse_xml("<Product><DescriptiveDetail><TitleDetail><TitleElement>"
                     "<TitleText>  </TitleText></TitleElement></TitleDetail></DescriptiveDetail></Product>") is None


def test_title_outside_descriptive_detail_is_ignored():
    body = (
        "<Product><RelatedMaterial><TitleText>Inna książka</TitleText></RelatedMaterial>"
        "<DescriptiveDetail><TitleDetail><TitleElement><TitleText>Właściwy</TitleText>"
        "</TitleElement></TitleDetail></DescriptiveDetail></Product>"
    )
    assert parse_xml(body).title == "Właściwy"


def test_title_text_is_not_trimmed_of_catalog_punctuation():
    body = ("<Product><DescriptiveDetail><TitleDetail><TitleElement><TitleText> Tytuł / </TitleText>"
            "</TitleElement></TitleDetail></DescriptiveDetail></Product>")
    assert parse_xml(body).title == "Tytuł /"


def test_title_without_prefix_alone():
    body = ("<Product><DescriptiveDetail><TitleDetail><TitleElement><TitleWithoutPrefix>Hobbit</TitleWithoutPrefix>"
            "</TitleElement></TitleDetail></DescriptiveDetail></Product>")
    assert parse_xml(body).title == "Hobbit"


def test_contributor_rules():
    descriptive = (
        "<Contributor><ContributorRole>A12</ContributorRole><PersonName>Ilustrator</PersonName></Contributor>"
        "<Contributor><ContributorRole>A01</ContributorRole><PersonName>Anna Nowak</PersonName>"
        "<PersonNameInverted>Nowak, Anna</PersonNameInverted></Contributor>"
    )
    assert parse_xml(product(descriptive)).author_name == "Anna Nowak"
    only_role = "<Contributor><ContributorRole>A01</ContributorRole></Contributor>"
    assert parse_xml(product(only_role)).author_name is None


def test_imprint_wins_over_publisher_and_publisher_is_normalised():
    both = "<Imprint><ImprintName>Znak,</ImprintName></Imprint><Publisher><PublisherName>X</PublisherName></Publisher>"
    assert parse_xml(product(publishing=both)).publisher == "Znak,"
    publisher_only = '<Publisher><PublisherName>Wydawnictwo "Znak" :</PublisherName></Publisher>'
    assert parse_xml(product(publishing=publisher_only)).publisher == "Wydawnictwo „Znak”"


def test_role_01_date_overrides_earlier_date():
    dates = (
        "<PublishingDate><PublishingDateRole>09</PublishingDateRole><Date>20150101</Date></PublishingDate>"
        "<PublishingDate><PublishingDateRole>01</PublishingDateRole><Date>2013</Date></PublishingDate>"
        "<PublishingDate><PublishingDateRole>01</PublishingDateRole><Date>abcd</Date></PublishingDate>"
    )
    assert parse_xml(product(publishing=dates)).year == 2013


def test_extent_types_00_and_11_override():
    extents = (
        "<Extent><ExtentType>08</ExtentType><ExtentValue>400</ExtentValue><ExtentUnit>03</ExtentUnit></Extent>"
        "<Extent><ExtentType>11</ExtentType><ExtentValue>350</ExtentValue><ExtentUnit>03</ExtentUnit></Extent>"
        "<Extent><ExtentType>08</ExtentType><ExtentValue>500</ExtentValue><ExtentUnit>03</ExtentUnit></Extent>"
        "<Extent><ExtentType>00</ExtentType><ExtentValue>0</ExtentValue><ExtentUnit>03</ExtentUnit></Extent>"
    )
    assert parse_xml(product(extents)).page_count == 350
    too_many = "<Extent><ExtentType>00</ExtentType><ExtentValue>12000</ExtentValue><ExtentUnit>03</ExtentUnit></Extent>"
    assert parse_xml(product(too_many)).page_count is None  # poprawka §9.7


def test_part_number_in_title_element():
    descriptive = "<TitleDetail><TitleElement><PartNumber>Tom II</PartNumber></TitleElement></TitleDetail>"
    info = parse_xml(product(descriptive))
    assert info.volume_number == 2
    assert info.series_name is None


def test_series_from_collection_only_once():
    descriptive = (
        "<Collection><TitleDetail><TitleElement><TitleText></TitleText></TitleElement></TitleDetail></Collection>"
        "<Collection><TitleDetail><TitleElement><TitleText>Mądra Mysz ;</TitleText></TitleElement></TitleDetail></Collection>"
        "<Collection><TitleDetail><TitleElement><TitleText>Druga seria</TitleText></TitleElement></TitleDetail></Collection>"
    )
    info = parse_xml(product(descriptive))
    assert (info.series_name, info.is_series_certain) == ("Mądra Mysz", True)


def test_elements_without_namespace_also_work():
    xml = ("<ONIXMessage><Product><DescriptiveDetail><TitleDetail><TitleElement><TitleText>Bez przestrzeni"
           "</TitleText></TitleElement></TitleDetail></DescriptiveDetail></Product></ONIXMessage>")
    assert onix.parse(xml.encode(), make_isbn("9788375780635")).title == "Bez przestrzeni"


def test_unbound_prefix_is_malformed():
    xml = "<onix:ONIXMessage><onix:Product/></onix:ONIXMessage>"
    assert onix.parse(xml.encode(), make_isbn("9788375780635")) is None
