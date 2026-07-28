/*
 * FourAwardHelper
 *
 * Notes:
 * - This is intentionally conservative in a few places where wikitext varies.
 * - The article creation date is auto-detected from the oldest non-redirect revision when possible,
 *   but the user must still verify it.
 * - Article history parsing is template-based and may need adjustment if local formatting varies.
 */

(function () {
'use strict';

const DEBUG = true;
const DEBUG_PREFIX = '[FourAwardHelper]';

function debug(){
    if(DEBUG && window.console){
        console.log(DEBUG_PREFIX, ...arguments);
    }
}

function warn(){
    if(window.console){
        console.warn(DEBUG_PREFIX, ...arguments);
    }
}

function error(){
    if(window.console){
        console.error(DEBUG_PREFIX, ...arguments);
    }
}

debug('loaded', {
    pageName: mw.config.get('wgPageName'),
    action: mw.config.get('wgAction'),
    oldid: mw.config.get('wgRevisionId'),
    url: location.href
});

if (mw.config.get('wgPageName') !== 'Wikipedia:Four_Award') {
    debug('stopping: not Wikipedia:Four_Award');
    return;
}

const RECORDS_PAGE = 'Wikipedia:Four Award/Records';
const MAIN_PAGE = 'Wikipedia:Four Award';
const LOG_PAGE = 'User:' + mw.config.get('wgUserName') + '/4award/log';

let codexPromise;
let apiPromise;

function getApi(){
    if(!apiPromise){
        debug('loading mediawiki.api');
        apiPromise=mw.loader.using(['mediawiki.api']).then(function(){
            debug('mediawiki.api loaded');
            return new mw.Api();
        }).catch(function(e){
            error('mediawiki.api failed to load', e);
            throw e;
        });
    }
    return apiPromise;
}

function loadCodex(){
    if(!codexPromise){
        debug('loading @wikimedia/codex');
        codexPromise=mw.loader.using(['@wikimedia/codex']).then(function(require){
            const Vue=require('vue');
            const Codex=require('@wikimedia/codex');
            debug('@wikimedia/codex loaded', {
                hasVue: !!Vue,
                hasDialog: !!Codex.CdxDialog,
                hasButton: !!Codex.CdxButton,
                hasTextInput: !!Codex.CdxTextInput,
                hasTextArea: !!Codex.CdxTextArea,
                hasCheckbox: !!Codex.CdxCheckbox,
                hasField: !!Codex.CdxField
            });
            return {
                Vue,
                CdxDialog: Codex.CdxDialog,
                CdxButton: Codex.CdxButton,
                CdxTextInput: Codex.CdxTextInput,
                CdxTextArea: Codex.CdxTextArea,
                CdxCheckbox: Codex.CdxCheckbox,
                CdxField: Codex.CdxField
            };
        }).catch(function(e){
            error('@wikimedia/codex failed to load', e);
            throw e;
        });
    }
    return codexPromise;
}

/* ================= UTIL ================= */
function withTag(summary){
    return summary + ' ([[User:Alachuckthebuck/FourAwardHelper|FourAwardHelper]])';
}
function today(){ return new Date().toISOString().slice(0,10); }

function signatureWikitext(){
    let signature='';
    for(let i=0; i<4; i++){
        signature+='~';
    }
    return signature;
}

function toDts(d){
    if(!d) return '';
    let m=String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `{{dts|${m[1]}|${m[2]}|${m[3]}}}` : d;
}

function buildUserLink(user, count, userDisplay){
    let cleanUser=cleanUserForLink(user);
    let cleanDisplay=String(userDisplay || cleanUser).trim();

    // The repeat-award number belongs outside the wikilink in plain text:
    //   [[User:Example|Example]] (2)
    // not:
    //   [[User:Example|Example (2)]]
    let link=`[[User:${cleanUser}|${cleanDisplay}]]`;
    return count && count > 1 ? link + ' (' + count + ')' : link;
}

function buildArticleLink(article, display){
    let cleanArticle=String(article || '').trim();
    let cleanDisplay=String(display || '').trim();

    if(cleanDisplay && cleanDisplay !== cleanArticle){
        return `[[${cleanArticle}|${cleanDisplay}]]`;
    }

    return `[[${cleanArticle}]]`;
}

function buildArticleCell(d){
    // Existing records can contain intentional nonstandard markup around the
    // article link, for example italicized albums, quoted songs, daggers, or
    // notes. Preserve that exact cell when rebuilding the table. For newly
    // added records, fall back to a normal wikilink from the parsed title.
    let raw=String(d.articleCellRaw || '').trim();
    if(raw){
        return raw;
    }
    return buildArticleLink(d.article, d.articleDisplay);
}

function buildRow(d, count){
    // Use real wikitable row syntax. Do NOT put cells after the row marker
    // (`|- || ...`), because MediaWiki can treat that as row attributes and
    // produce a malformed/extra-column row.
    let cells=[
        buildUserLink(d.user, count || d.userAwardCount || d.count || 1, d.userDisplay),
        buildArticleCell(d),
        toDts(d.awardDate),
        toDts(d.creationDate),
        toDts(d.dykDate),
        toDts(d.gaDate),
        toDts(d.faDate)
    ];

    return '|-\n| ' + cells.join(' || ');
}

function normalizeUser(u){
    return String(u||'').toLowerCase().replace(/_/g,' ').trim();
}

function safeDecode(value){
    try{
        return decodeURIComponent(String(value || '')).replace(/_/g,' ');
    }catch(e){
        return String(value || '').replace(/_/g,' ');
    }
}

function titleFromWikiUrl(url){
    if(!url) return '';
    let raw=String(url);

    try{
        let titleMatch=raw.match(/[?&]title=([^&#]+)/);
        if(titleMatch){
            return safeDecode(titleMatch[1]);
        }

        let wikiMatch=raw.match(/\/wiki\/([^?#]+)/);
        if(wikiMatch){
            return safeDecode(wikiMatch[1]);
        }

        return safeDecode(raw.split(/[?#]/)[0]);
    }catch(e){
        warn('titleFromWikiUrl failed', {url: raw, e});
        return '';
    }
}

function getLinkTitle(link){
    let $link=$(link);
    let title=$link.attr('title');
    if(title) return safeDecode(title);

    let href=$link.attr('href') || '';
    let extracted=titleFromWikiUrl(href);
    return extracted || '';
}

function getLinkSearchText(link){
    let $link=$(link);
    return safeDecode([
        $link.attr('href') || '',
        $link.attr('title') || '',
        $link.text() || ''
    ].join(' '));
}

function isArticleTitle(title){
    return title && !/^(Wikipedia|User|User talk|Talk|Special|File|Help|Template|Category|Portal|Draft|Module|MediaWiki):/i.test(title);
}

function firstArticleLinkData(root){
    let found={title:'', display:''};
    let count=0;
    root.find('a[href*="/wiki/"], a[title]').each(function(){
        count++;
        let title=getLinkTitle(this);
        if(isArticleTitle(title)){
            found={
                title,
                display: String($(this).text() || '').trim()
            };
            return false;
        }
    });
    debug('firstArticleLinkData result', {found, candidateLinks: count, text: root.text().trim().slice(0,120)});
    return found;
}

function firstArticleTitle(root){
    return firstArticleLinkData(root).title;
}

function firstHrefMatching(root, pattern){
    let href='';
    let count=0;
    root.find('a[href]').each(function(){
        count++;
        let searchText=getLinkSearchText(this);
        pattern.lastIndex=0;
        if(pattern.test(searchText)){
            href=$(this).attr('href') || '';
            return false;
        }
    });
    debug('firstHrefMatching result', {pattern: String(pattern), href, candidateLinks: count});
    return href;
}

function findNominationLinkData(content){
    return {
        dyk:firstHrefMatching(
            content,
            /Recent[ _]additions\/\d{4}\/[A-Za-z]+#\d{1,2}|Did[ _]you[ _]know/i
        ),
        ga:firstHrefMatching(
            content,
            /Talk:[^\s#?]+\/GA\d+|\/GA\d+(?:$|[?#\s])|Good[ _]article[ _]nominations/i
        ),
        fac:firstHrefMatching(
            content,
            /Featured[ _]article[ _]candidates|FAC\/archive|featured article/i
        )
    };
}

function normalizeTemplateParam(value){
    return String(value || '').replace(/\|/g, '{{!}}');
}

function nowikiText(value){
    return String(value || '').replace(/<\/nowiki>/gi,'</nowiki><nowiki/>');
}

/* ================= API ================= */

async function getWikitext(title){
    debug('getWikitext start', title);
    let api=await getApi();
    let r = await api.get({
        action:'query',
        prop:'revisions',
        rvslots:'main',
        rvprop:'content',
        titles:title,
        formatversion:2
    });
    let page=r?.query?.pages?.[0];
    return page?.revisions?.[0]?.slots?.main?.content || '';
}

async function edit(title,text,summary){
    debug('edit start', {title, summary, textLength: text.length});
    let api=await getApi();
    return api.postWithEditToken({
        action:'edit',
        title,
        text,
        summary: withTag(summary)
    });
}

async function parseWikitext(title,text,sectionTitle){
    debug('parseWikitext start', {title, textLength: String(text || '').length, sectionTitle});
    let api=await getApi();
    let params={
        action:'parse',
        title:title || mw.config.get('wgPageName'),
        text:text,
        prop:'text|modules|modulestyles|jsconfigvars',
        pst:true,
        formatversion:2
    };

    if(sectionTitle){
        params.section='new';
        params.sectiontitle=sectionTitle;
    }

    let r=await api.post(params);
    let parse=r?.parse || {};

    if(parse.modules?.length){
        mw.loader.load(parse.modules);
    }
    if(parse.modulestyles?.length){
        mw.loader.load(parse.modulestyles);
    }

    return parse.text || '';
}

/* ================= TABLE ================= */

function displayUserName(user, count){
    user=String(user || '').trim();
    return count && count > 1 ? user + ' (' + count + ')' : user;
}

function makeUserLink(user, count){
    let cleanUser=String(user || '').trim();
    return '[[User:' + cleanUser + '|' + displayUserName(cleanUser, count) + ']]';
}

function makeArticleLink(data){
    let article=String(data.article || '').trim();
    let display=String(data.articleDisplay || '').trim();

    if(display && display !== article){
        return '[[' + article + '|' + display + ']]';
    }

    return '[[' + article + ']]';
}

function normalizeArticleTitle(title){
    return String(title || '')
        .replace(/_/g,' ')
        .replace(/\s+/g,' ')
        .trim();
}

function normalizeArticleForCompare(title){
    return normalizeArticleTitle(title).toLowerCase();
}

function stripFourAwardCount(userDisplay){
    return String(userDisplay || '')
        .replace(/\s*\(\d+\)\s*$/,'')
        .trim();
}

function stripCellSyntax(cell){
    let s=String(cell || '').trim();

    // Remove row/cell markers left over from malformed generated rows.
    s=s.replace(/^\s*\|-+\s*/, '').trim();
    s=s.replace(/^\s*\|+\s*/, '').trim();

    // Remove wikitable cell attributes like:
    //   style="..." | content
    //   class="..." | content
    // Do this carefully and repeatedly, but only before the real cell content.
    let safety=0;
    while(safety++ < 8){
        let m=s.match(/^(?:[a-zA-Z-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^|]+))?\s*)+\|\s*(.*)$/);
        if(!m) break;
        s=m[1].trim();
    }

    return s;
}

function firstSimpleUserLink(text){
    let s=String(text || '');
    let re=/\[\[\s*User\s*:\s*([^|\]\[]+)(?:\|([^\]\[]+))?\]\]/ig;
    let m;
    let found=null;

    // Prefer the last simple, non-nested User link. This repairs rows that were
    // accidentally rebuilt as [[User:[[User:Foo|Foo]]|[[User:Foo|Foo]]]].
    while((m=re.exec(s))){
        found={
            target:'User:' + m[1].trim(),
            display:(m[2] || m[1]).trim()
        };
    }

    return found;
}

function parseWikiLinkCell(cell){
    cell=stripCellSyntax(cell);

    // General first link parser. It intentionally looks for a non-nested link,
    // so malformed double-wrapped links can still be recovered by the specific
    // user parser below.
    let m=cell.match(/\[\[\s*([^|\]#\[]+)(?:#[^|\]]*)?(?:\|([^\]\[]+))?\]\]/);
    if(!m){
        return {target:cell, display:cell};
    }

    return {
        target:m[1].trim(),
        display:(m[2] || m[1]).trim()
    };
}

function parseUserCell(cell){
    let originalCell=String(cell || '');
    cell=stripCellSyntax(cell);

    let link=firstSimpleUserLink(cell) || parseWikiLinkCell(cell);

    let target=String(link.target || '')
        .replace(/^\s*User\s*:/i,'')
        .trim();

    let display=String(link.display || target)
        .replace(/^\s*User\s*:/i,'')
        .trim();

    // If a bad previous build left a full user link as the target or display,
    // unwrap it one more time.
    let nested=firstSimpleUserLink(target) || firstSimpleUserLink(display);
    if(nested){
        target=String(nested.target || '')
            .replace(/^\s*User\s*:/i,'')
            .trim();
        display=String(nested.display || target)
            .replace(/^\s*User\s*:/i,'')
            .trim();
    }

    // Support both historical formats:
    //   [[User:Name|Name (2)]]
    // and the preferred format:
    //   [[User:Name|Name]] (2)
    let countMatch=String(originalCell).match(/\]\]\s*\((\d+)\)\s*$/) ||
        String(link.display || '').match(/\((\d+)\)\s*$/) ||
        String(display || '').match(/\((\d+)\)\s*$/);
    let count=countMatch ? parseInt(countMatch[1],10) : 1;

    target=stripFourAwardCount(target);
    display=stripFourAwardCount(display);

    // Last-ditch cleanup for corrupt text, without damaging legitimate names.
    target=target.replace(/^\[+|\]+$/g,'').trim();
    display=display.replace(/^\[+|\]+$/g,'').trim();

    return {
        user:target,
        userDisplay:display || target,
        count:count
    };
}

function cleanUserForLink(user){
    let parsed=parseUserCell(user);
    return parsed.user || String(user || '').replace(/^\s*User\s*:/i,'').trim();
}

function parseDtsCell(cell){
    cell=String(cell || '').trim();

    let m=cell.match(/\{\{dts\|(\d{4})\|(\d{1,2})\|(\d{1,2})\}\}/i);
    if(m){
        return [m[1], String(m[2]).padStart(2,'0'), String(m[3]).padStart(2,'0')].join('-');
    }

    return cell;
}

function splitRecordRowCells(rowText){
    let lines=String(rowText || '').split('\n');
    let cells=[];

    function addCellsFromLine(cellLine){
        cellLine=String(cellLine || '').trim();
        if(!cellLine) return;

        // Remove leading table-cell markers, but leave pipes inside wikilinks
        // and templates alone. This handles both:
        //   | cell || cell
        // and old malformed rows that looked like:
        //   |- || cell || cell
        cellLine=cellLine.replace(/^\|+\s*/, '');

        cellLine.split(/\s*\|\|\s*/).forEach(function(part){
            let cell=stripCellSyntax(part);
            if(cell !== ''){
                cells.push(cell);
            }
        });
    }

    lines.forEach(function(line){
        let trimmed=line.trim();

        if(!trimmed || /^\|}/.test(trimmed) || /^!/.test(trimmed)){
            return;
        }

        if(/^\|-/.test(trimmed)){
            // Some previous versions incorrectly generated `|- || cell...`.
            // Treat anything after the row marker as cells so old damage can be
            // parsed and normalized on the next save.
            let afterMarker=trimmed.replace(/^\|-\s*/, '').trim();
            if(afterMarker){
                addCellsFromLine(afterMarker);
            }
            return;
        }

        if(/^\|/.test(trimmed)){
            addCellsFromLine(trimmed);
        }
    });

    return cells;
}

function parseRecordRow(rowText){
    let cells=splitRecordRowCells(rowText);

    if(cells.length < 7){
        debug('parseRecordRow skipped: fewer than 7 cells', {
            cells:cells,
            row:String(rowText || '').slice(0,300)
        });
        return null;
    }

    // If a future table adds extra cells, keep the first seven expected columns.
    cells=cells.slice(0,7);

    let parsedUser=parseUserCell(cells[0]);
    let rawArticleCell=stripCellSyntax(cells[1]);
    let articleLink=parseWikiLinkCell(rawArticleCell);

    return {
        user:parsedUser.user,
        userDisplay:parsedUser.userDisplay,
        article:normalizeArticleTitle(articleLink.target),
        articleDisplay:articleLink.display !== articleLink.target ? articleLink.display : '',
        articleCellRaw:rawArticleCell,
        awardDate:parseDtsCell(cells[2]),
        creationDate:parseDtsCell(cells[3]),
        dykDate:parseDtsCell(cells[4]),
        gaDate:parseDtsCell(cells[5]),
        faDate:parseDtsCell(cells[6]),
        count:parsedUser.count
    };
}

function extractRecordsTable(text){
    let lines=String(text || '').split('\n');
    let start=-1;
    let end=-1;

    // Find the records wikitable by its header text rather than by row format.
    // This survives both one-line rows and normal multiline wikitable rows.
    for(let i=0; i<lines.length; i++){
        if(/^\s*\{\|/.test(lines[i])){
            let preview=lines.slice(i, Math.min(i + 30, lines.length)).join('\n');
            if(
                /User/i.test(preview) &&
                /Article/i.test(preview) &&
                /DYK/i.test(preview) &&
                /GA/i.test(preview) &&
                /FA/i.test(preview)
            ){
                start=i;
                break;
            }
        }
    }

    if(start === -1){
        throw new Error('Could not find the Four Award records table');
    }

    // Find the matching table close. Keep a depth counter in case a cell ever
    // contains a nested table.
    let depth=0;
    for(let i=start; i<lines.length; i++){
        if(/^\s*\{\|/.test(lines[i])){
            depth++;
        }
        if(/^\s*\|}/.test(lines[i])){
            depth--;
            if(depth === 0){
                end=i;
                break;
            }
        }
    }

    if(end === -1){
        throw new Error('Could not find the end of the Four Award records table');
    }

    return {
        before:lines.slice(0,start).join('\n'),
        table:lines.slice(start,end + 1).join('\n'),
        after:lines.slice(end + 1).join('\n')
    };
}

function getRecordRowBlocks(tableText){
    let lines=String(tableText || '').split('\n');
    let blocks=[];
    let current=[];
    let inRow=false;

    lines.forEach(function(line){
        if(/^\s*\|-/.test(line)){
            if(inRow && current.length){
                blocks.push(current.join('\n'));
            }
            current=[line];
            inRow=true;
            return;
        }

        if(inRow){
            if(/^\s*\|}/.test(line)){
                if(current.length){
                    blocks.push(current.join('\n'));
                }
                current=[];
                inRow=false;
                return;
            }
            current.push(line);
        }
    });

    if(inRow && current.length){
        blocks.push(current.join('\n'));
    }

    return blocks.filter(function(block){
        return splitRecordRowCells(block).length >= 7;
    });
}

function parseRecordsTable(tableText){
    return getRecordRowBlocks(tableText)
        .map(function(block, index){
            let record=parseRecordRow(block);
            if(record){
                record.__order=index;
            }
            return record;
        })
        .filter(Boolean);
}

function findFirstRecordRowLine(lines){
    for(let i=0; i<lines.length; i++){
        if(/^\s*\|-/.test(lines[i])){
            let block=[];
            for(let j=i; j<lines.length; j++){
                if(j>i && /^\s*\|-/.test(lines[j])) break;
                if(/^\s*\|}/.test(lines[j])) break;
                block.push(lines[j]);
            }
            if(splitRecordRowCells(block.join('\n')).length >= 7){
                return i;
            }
        }
    }
    return -1;
}

function recordExistsInRecords(records,user,article){
    // Exact duplicate protection only.
    // A Four Award can be awarded to multiple users for the same article, so
    // same article + different user must be allowed. The only duplicate is
    // the same normalized user receiving the same normalized article twice.
    let uNorm=normalizeUser(user);
    let aNorm=normalizeArticleForCompare(article);

    return records.some(function(record){
        return normalizeUser(record.user) === uNorm &&
            normalizeArticleForCompare(record.article) === aNorm;
    });
}

function findOtherUsersForArticle(records,user,article){
    let uNorm=normalizeUser(user);
    let aNorm=normalizeArticleForCompare(article);

    return records.filter(function(record){
        return normalizeArticleForCompare(record.article) === aNorm &&
            normalizeUser(record.user) !== uNorm;
    });
}

function dateGrantedSortKey(record){
    // Four Award numbering is chronological by the date the award was granted.
    // Use the normalized YYYY-MM-DD awardDate when available. Blank or malformed
    // dates sort last, then fall back to original table order/article for safety.
    let date=String(record.awardDate || '').trim();
    if(/^\d{4}-\d{2}-\d{2}$/.test(date)){
        return date;
    }
    return '9999-99-99';
}

function compareRecordsByDateGranted(a,b){
    let dateCompare=dateGrantedSortKey(a).localeCompare(dateGrantedSortKey(b));
    if(dateCompare !== 0){
        return dateCompare;
    }

    let orderCompare=(a.__order ?? 999999) - (b.__order ?? 999999);
    if(orderCompare !== 0){
        return orderCompare;
    }

    return normalizeArticleForCompare(a.article).localeCompare(
        normalizeArticleForCompare(b.article),
        undefined,
        {sensitivity:'base'}
    );
}

function compareRecords(a,b){
    let userCompare=normalizeUser(a.user).localeCompare(
        normalizeUser(b.user),
        undefined,
        {sensitivity:'base'}
    );

    if(userCompare !== 0){
        return userCompare;
    }

    // Within each user, the Four Award count is based on date granted.
    // normalizeFourAwardCounts() assigns count after this chronological sort,
    // so this comparator keeps the final table in the same sequence.
    return compareRecordsByDateGranted(a,b);
}

function maxAwardCountForUser(records,user){
    let key=normalizeUser(user);
    let max=0;

    records.forEach(function(record){
        if(normalizeUser(record.user) === key){
            max=Math.max(max, parseInt(record.count,10) || 1);
        }
    });

    return max;
}

function normalizeFourAwardCounts(records){
    let groups={};

    records.forEach(function(record){
        let key=normalizeUser(record.user);
        if(!groups[key]) groups[key]=[];
        groups[key].push(record);
    });

    Object.keys(groups).forEach(function(key){
        let group=groups[key];

        // The canonical order for repeat Four Awards is the date granted, not
        // the previous table position and not a preassigned count. This avoids
        // off-by-one numbering when the old table was already out of order or
        // when a new nomination is inserted before/after existing rows.
        group.sort(compareRecordsByDateGranted);

        // Assign final counts ONLY after the chronological order is known.
        group.forEach(function(record,index){
            record.count=index + 1;
        });
    });

    return records;
}

function getNextCount(text,user){
    try{
        let records=parseRecordsTable(extractRecordsTable(text).table);
        normalizeFourAwardCounts(records);
        return maxAwardCountForUser(records,user) + 1;
    }catch(e){
        warn('getNextCount failed; falling back to 1', e);
        return 1;
    }
}

function rebuildRecordsTable(originalTableText,records){
    let lines=String(originalTableText || '').split('\n');
    let firstDataRow=findFirstRecordRowLine(lines);
    let tableEnd=lines.findIndex(function(line){
        return line.trim() === '|}';
    });

    if(tableEnd === -1){
        throw new Error('Could not identify end of records table');
    }

    // If the table has no existing data rows, insert just before |}.
    if(firstDataRow === -1){
        firstDataRow=tableEnd;
    }

    let header=lines.slice(0,firstDataRow).join('\n').replace(/\s*$/,'');
    let footer=lines.slice(tableEnd).join('\n').replace(/^\s*/,'');
    let rows=records.map(function(record){
        return buildRow(record, record.count);
    }).join('\n');

    return header + '\n' + rows + '\n' + footer;
}

function addRecordAndRebuildPage(text,data){
    let parts=extractRecordsTable(text);
    let records=parseRecordsTable(parts.table);

    if(recordExistsInRecords(records,data.user,data.article)){
        throw new Error('Duplicate: this user already has a Four Award recorded for this article');
    }

    let coAwardRecords=findOtherUsersForArticle(records,data.user,data.article);
    if(coAwardRecords.length){
        debug('same article already has Four Award records for other users; allowing co-award', {
            article:data.article,
            existingUsers:coAwardRecords.map(function(record){ return record.user; })
        });
    }

    records.push({
        user:data.user,
        article:data.article,
        articleDisplay:data.articleDisplay || '',
        awardDate:data.awardDate,
        creationDate:data.creationDate,
        dykDate:data.dykDate,
        gaDate:data.gaDate,
        faDate:data.faDate,

        // Do not preassign count here. Count is assigned only after the full
        // table has been sorted by date granted, which prevents off-by-one
        // errors for repeat winners.
        __order:999999
    });

    normalizeFourAwardCounts(records);
    records.sort(compareRecords);

    let rebuiltTable=rebuildRecordsTable(parts.table,records);
    return [
        parts.before.replace(/\s*$/,''),
        rebuiltTable,
        parts.after.replace(/^\s*/,'')
    ].filter(function(part){
        return part !== '';
    }).join('\n\n');
}

function findRecord(records,user,article){
    let uNorm=normalizeUser(user);
    let aNorm=normalizeArticleForCompare(article);

    return records.find(function(record){
        return normalizeUser(record.user) === uNorm &&
            normalizeArticleForCompare(record.article) === aNorm;
    });
}

/* ================= DATES ================= */

async function getCreationDate(article){
    debug('getCreationDate start', article);
    let api=await getApi();
    let r=await api.get({
        action:'query',
        prop:'revisions',
        titles:article,
        rvlimit:1,
        rvdir:'newer',
        rvprop:'timestamp',
        formatversion:2
    });
    return r?.query?.pages?.[0]?.revisions?.[0]?.timestamp?.slice(0,10)||'';
}

function parseDYK(url){
    if(!url) return '';
    let decoded=safeDecode(url);

    let m=decoded.match(/Recent additions\/(\d{4})\/([A-Za-z]+)#(\d{1,2})(?:\D|$)/i) ||
        decoded.match(/(\d{4})\/([A-Za-z]+)#(\d{1,2})(?:\D|$)/i);

    if(!m) return '';

    let parsed=new Date(`${m[2]} ${m[3]}, ${m[1]} UTC`);
    return isNaN(parsed) ? '' : parsed.toISOString().slice(0,10);
}

async function parseGA(gaUrlOrArticle){
    debug('parseGA start', gaUrlOrArticle);
    if(!gaUrlOrArticle) return '';

    let api=await getApi();
    let title=titleFromWikiUrl(gaUrlOrArticle) || gaUrlOrArticle;

    let r=await api.get({
        action:'query',
        prop:'revisions',
        titles:title,
        rvlimit:200,
        rvprop:'timestamp|user|comment',
        rvdir:'newer',
        formatversion:2
    });

    let revs=r?.query?.pages?.[0]?.revisions||[];

    for(let rev of revs){
        if(
            rev.user==='ChristieBot' ||
            /good article|GA passed|GA promoted|listed as a good article|passed/i.test(rev.comment||'')
        ){
            return rev.timestamp.slice(0,10);
        }
    }

    if(/\/GA\d+$/i.test(title) && revs.length){
        return revs[revs.length-1].timestamp.slice(0,10);
    }

    return '';
}

async function parseFAC(url,article){
    debug('parseFAC start', {url, article});
    if(!url) return {date:'',status:''};

    try{
        let title=titleFromWikiUrl(url);
        if(!title) return {date:'',status:''};

        // Use raw source, not action=parse, so templates are not expanded.
        let text=await getWikitext(title);

        let status=/promoted/i.test(text)?'promoted':'';
        let m=text.match(/promoted.*?(\d{1,2} [A-Za-z]+ \d{4})/is) ||
            text.match(/archive(?:d)? .*?(\d{1,2} [A-Za-z]+ \d{4})/is);

        let parsed=m ? new Date(`${m[1]} UTC`) : null;
        return {
            status,
            date: parsed && !isNaN(parsed) ? parsed.toISOString().slice(0,10) : ''
        };

    }catch(e){
        warn('parseFAC failed', e);
        return {date:'',status:''};
    }
}


/* ================= ARTICLE HISTORY ================= */

function titleToTalkTitle(title){
    let clean=String(title || '').replace(/_/g,' ').replace(/^:/,'').split('#')[0].trim();
    if(!clean) return '';

    let m=clean.match(/^([^:]+):(.*)$/);
    if(!m){
        return 'Talk:' + clean;
    }

    let ns=m[1].toLowerCase().replace(/_/g,' ');
    let rest=m[2].trim();
    let talkNamespaces={
        'user':'User talk',
        'wikipedia':'Wikipedia talk',
        'wp':'Wikipedia talk',
        'file':'File talk',
        'image':'File talk',
        'mediawiki':'MediaWiki talk',
        'template':'Template talk',
        'help':'Help talk',
        'category':'Category talk',
        'portal':'Portal talk',
        'draft':'Draft talk',
        'module':'Module talk',
        'timedtext':'TimedText talk',
        'book':'Book talk',
        'education program':'Education Program talk'
    };

    return (talkNamespaces[ns] || (m[1] + ' talk')) + ':' + rest;
}

function normalizeTemplateName(name){
    return String(name || '')
        .replace(/_/g,' ')
        .replace(/\s+/g,' ')
        .trim()
        .toLowerCase();
}

function getTemplateNameAt(text,start){
    let after=text.slice(start+2);
    let m=after.match(/^\s*([^|}\n]+)/);
    return m ? normalizeTemplateName(m[1]) : '';
}

function findTemplateRange(text,names){
    let wanted=names.map(normalizeTemplateName);
    let pos=0;

    while(true){
        let start=text.indexOf('{{',pos);
        if(start===-1) return null;

        let name=getTemplateNameAt(text,start);
        if(wanted.includes(name)){
            let depth=0;
            for(let i=start; i<text.length-1; i++){
                let pair=text.slice(i,i+2);
                if(pair==='{{'){
                    depth++;
                    i++;
                    continue;
                }
                if(pair==='}}'){
                    depth--;
                    i++;
                    if(depth===0){
                        return {start,end:i+1};
                    }
                }
            }
            return null;
        }

        pos=start+2;
    }
}

function setTemplateParameter(templateText,param,value){
    let paramPattern=new RegExp('(\\|\\s*' + param.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '\\s*=\\s*)([^|}\\n]*)','i');

    if(paramPattern.test(templateText)){
        return templateText.replace(paramPattern,'$1' + value);
    }

    let close=templateText.lastIndexOf('}}');
    if(close===-1){
        return templateText;
    }

    let before=templateText.slice(0,close).replace(/\s*$/,'');
    let after=templateText.slice(close);
    return before + '\n|' + param + '=' + value + '\n' + after;
}

function setArticleHistoryFour(text,value){
    let range=findTemplateRange(text,[
        'Article history',
        'ArticleHistory'
    ]);

    if(!range){
        return {text, changed:false, reason:'No {{Article history}} template found'};
    }

    let oldTemplate=text.slice(range.start,range.end);
    let fourValue=value || 'yes';
    let newTemplate=setTemplateParameter(oldTemplate,'four',fourValue);

    if(newTemplate===oldTemplate){
        return {text, changed:false, reason:'Article history template already has four=' + fourValue + ' or could not be changed'};
    }

    return {
        text:text.slice(0,range.start) + newTemplate + text.slice(range.end),
        changed:true,
        reason:''
    };
}

async function updateArticleHistoryFour(article,value,summaryPrefix){
    let talkTitle=titleToTalkTitle(article);
    let fourValue=value || 'yes';
    debug('updateArticleHistoryFour start', {article, talkTitle, fourValue});

    if(!talkTitle){
        return {updated:false, reason:'Could not determine talk page title'};
    }

    let talkText=await getWikitext(talkTitle);
    let result=setArticleHistoryFour(talkText,fourValue);

    if(!result.changed){
        debug('updateArticleHistoryFour no change', {talkTitle, reason:result.reason});
        return {updated:false, reason:result.reason, talkTitle};
    }

    await edit(talkTitle,result.text,(summaryPrefix || 'Marking Four Award in article history') + ' for [[' + article + ']]');
    return {updated:true, reason:'', talkTitle};
}


/* ================= NOMINATION REMOVAL ================= */

function sectionContainsArticle(sectionText, article){
    let target=normalizeArticleForCompare(article);
    let wikilinkRegex=/\[\[([^|\]#]+)(?:#[^|\]]*)?(?:\|[^\]]*)?\]\]/g;
    let m;

    while((m=wikilinkRegex.exec(sectionText))){
        if(normalizeArticleForCompare(m[1]) === target){
            return true;
        }
    }

    return normalizeArticleForCompare(sectionText).includes(target);
}

function headingUserFromWikitext(heading){
    let userMatch=String(heading || '').match(/\[\[User:([^|\]#]+)/i) ||
        String(heading || '').match(/\[\[User talk:([^|\]#]+)/i);

    if(userMatch){
        return userMatch[1].replace(/_/g,' ').trim();
    }

    let inner=String(heading || '')
        .replace(/^=+\s*/,'')
        .replace(/\s*=+\s*$/,'')
        .replace(/\[\[/g,'')
        .replace(/\]\]/g,'')
        .trim();

    if(inner.includes('|')){
        inner=inner.split('|').pop().trim();
    }

    return inner;
}

function removeSectionByUserAndArticle(text,user,article){
    let headingRegex=/^={4}\s*.*?\s*={4}\s*$/gmi;
    let matches=[];
    let m;

    while((m=headingRegex.exec(text))){
        matches.push({heading:m[0], index:m.index, end:headingRegex.lastIndex});
    }

    for(let i=0; i<matches.length; i++){
        let start=matches[i].index;
        let end=i+1 < matches.length ? matches[i+1].index : text.length;
        let section=text.slice(start,end);
        let headingUser=headingUserFromWikitext(matches[i].heading);

        if(normalizeUser(headingUser) === normalizeUser(user) && sectionContainsArticle(section, article)){
            return text.slice(0,start).replace(/\n*$/,'\n\n') + text.slice(end).replace(/^\n*/,'');
        }
    }

    return text;
}

async function removeNominationSection(data){
    debug('removeNominationSection start', data);
    let text=await getWikitext(MAIN_PAGE);
    let updated=removeSectionByUserAndArticle(text,data.user,data.article);

    if(updated === text){
        throw new Error('Could not find matching nomination section to remove');
    }

    await edit(MAIN_PAGE,updated,'Removing approved Four Award nomination for [[' + data.article + ']]');
    return {removed:true};
}

async function removeDeclinedNominationSection(data){
    debug('removeDeclinedNominationSection start', data);
    let text=await getWikitext(MAIN_PAGE);
    let updated=removeSectionByUserAndArticle(text,data.user,data.article);

    if(updated === text){
        throw new Error('Could not find matching nomination section to remove');
    }

    await edit(MAIN_PAGE,updated,'Removing declined Four Award nomination for [[' + data.article + ']]');
    return {removed:true};
}

/* ================= ACTIONS ================= */

function buildTalkText(article, customMessage){
    // Posts raw wikitext instead of a live template call, so no talk template remains transcluded.
    // customMessage is intentionally treated as wikitext so the approver can add links, italics, etc.
    let extraMessage = String(customMessage || '').trim();
    let messagePart = extraMessage ? '\n\n' + extraMessage : '';
    let signature=signatureWikitext();

    return `
{| style="border: 1px solid gray; background-color: #fdffe7;"
|rowspan="2" style="vertical-align:middle;" | 
[[File:Four Award with draft icon.svg|100px]]
|rowspan="2" |
|style="font-size: x-large; padding: 0; vertical-align: middle; height: 1.1em;" | '''Four Award'''
|-
|style="vertical-align: middle; border-top: 1px solid gray;" | Congratulations! You have been awarded the [[Wikipedia:Four Award|Four Award]] for your work from beginning to end on '''[[${article}]]'''.${messagePart} <span style="font-family:Courier">All the Best</span> -- ${signature}
|}`;
}

async function notifyUser(user, article, customMessage){
    debug('notifyUser start', {user, article, hasCustomMessage: !!String(customMessage || '').trim()});
    let api=await getApi();

    var talkText = buildTalkText(article, customMessage);
    var talkSectionTitle = 'Four Award for ' + article;

    await api.postWithEditToken({
        action:'edit',
        title:'User talk:'+user,
        section:'new',
        sectiontitle: talkSectionTitle,
        text: talkText,
        summary: withTag('Notifying user of Four Award for [[' + article + ']]')
    });
}

function buildDeclineTalkText(article, reason){
    let cleanReason=String(reason || '').trim();
    let reasonText=cleanReason || 'After review, this nomination does not currently meet the Four Award criteria.';
    let signature=signatureWikitext();

    return `The [[Wikipedia:Four Award|Four Award]] nomination for '''[[${article}]]''' was not successful at this time.

${reasonText}

Please feel free to renominate when the article and contributor history clearly meet the [[Wikipedia:Four Award#Requirements|Four Award requirements]].

-- ${signature}`;
}

async function notifyUserDeclined(user, article, reason){
    debug('notifyUserDeclined start', {user, article, hasReason: !!String(reason || '').trim()});
    let api=await getApi();

    await api.postWithEditToken({
        action:'edit',
        title:'User talk:'+user,
        section:'new',
        sectiontitle:'Four Award nomination for ' + article,
        text:buildDeclineTalkText(article, reason),
        summary:withTag('Notifying user of declined Four Award nomination for [[' + article + ']]')
    });
}

async function logAction(type,row){
    debug('logAction start', {type, row});
    let api=await getApi();
    await api.postWithEditToken({
        action:'edit',
        title:LOG_PAGE,
        appendtext:`\n== ${type} ==\n<nowiki>${nowikiText(row)}</nowiki>`,
        summary: withTag('Logging ' + type)
    });
}

async function approve(data){
    debug('approve start', {
        user:data.user,
        article:data.article,
        articleDisplay:data.articleDisplay,
        awardDate:data.awardDate,
        creationDate:data.creationDate,
        dykDate:data.dykDate,
        gaDate:data.gaDate,
        faDate:data.faDate
    });

    let recordsText=await getWikitext(RECORDS_PAGE);
    let updatedRecordsText=addRecordAndRebuildPage(recordsText,data);

    // Re-read the rebuilt table from the generated text so the log row exactly
    // matches the row that will be saved, including alphabetized count labels.
    let recordsAfter=parseRecordsTable(extractRecordsTable(updatedRecordsText).table);
    let savedRecord=findRecord(recordsAfter,data.user,data.article) || data;
    let row=buildRow(savedRecord,savedRecord.count || 1);

    await edit(RECORDS_PAGE,updatedRecordsText,'Adding Four Award for [[' + data.article + ']]');

    let articleHistoryResult=await updateArticleHistoryFour(data.article).catch(function(e){
        warn('updateArticleHistoryFour failed', e);
        return {updated:false, reason:e?.error?.info || e?.message || String(e)};
    });

    if(!articleHistoryResult.updated){
        warn('article history was not updated', articleHistoryResult);
        if(window.mw && mw.notify){
            mw.notify('Four Award helper warning: article history not updated: ' + (articleHistoryResult.reason || 'unknown reason'), {type:'warn'});
        }
    }

    if(data.notifyUserEnabled !== false){
        await notifyUser(data.user,data.article,data.customMessage);
    }else{
        debug('skipping user notification by request', {user:data.user, article:data.article});
    }

    let removalResult=await removeNominationSection(data).catch(function(e){
        warn('removeNominationSection failed', e);
        if(window.mw && mw.notify){
            mw.notify('Award processed, but nomination section was not removed: ' + (e?.message || e), {type:'warn'});
        }
        return {removed:false, reason:e?.message || String(e)};
    });
    debug('nomination removal result', removalResult);

    if(data.logActionEnabled !== false){
        await logAction('Approved',row);
    }else{
        debug('skipping approval log by request', {user:data.user, article:data.article, row});
    }
}

async function decline(data){
    debug('decline start', {
        user:data.user,
        article:data.article,
        reason:data.declineReason
    });

    let reason=String(data.declineReason || '').trim();
    if(!reason){
        throw new Error('Please add a decline reason before declining the nomination');
    }

    let removalResult=await removeDeclinedNominationSection(data).catch(function(e){
        warn('removeDeclinedNominationSection failed', e);
        if(window.mw && mw.notify){
            mw.notify('Decline notice not completed: nomination section was not removed: ' + (e?.message || e), {type:'error'});
        }
        throw e;
    });
    debug('declined nomination removal result', removalResult);

    if(data.notifyUserEnabled !== false){
        await notifyUserDeclined(data.user,data.article,reason);
    }else{
        debug('skipping declined user notification by request', {user:data.user, article:data.article});
    }

    let articleHistoryResult=await updateArticleHistoryFour(
        data.article,
        'no',
        'Marking declined Four Award in article history'
    ).catch(function(e){
        warn('updateArticleHistoryFour declined failed', e);
        return {updated:false, reason:e?.error?.info || e?.message || String(e)};
    });

    if(!articleHistoryResult.updated){
        warn('declined article history was not updated', articleHistoryResult);
        if(window.mw && mw.notify){
            mw.notify('Four Award helper warning: article history not updated: ' + (articleHistoryResult.reason || 'unknown reason'), {type:'warn'});
        }
    }

    if(data.logActionEnabled !== false){
        await logAction('Declined','[[' + data.article + ']] for [[User:' + data.user + ']]: ' + reason);
    }else{
        debug('skipping decline log by request', {user:data.user, article:data.article});
    }
}

/* ================= PARSER ================= */

function extractUserFromHeading(h4){
    let userLink=h4.find('a[href*="/wiki/User:"], a[title^="User:"]').first();
    return getLinkTitle(userLink)
        ? getLinkTitle(userLink).replace(/^User:/,'').trim()
        : (h4.attr('id') || h4.find('.mw-headline').attr('id') || '')
            .replace(/_/g,' ')
            .replace(/\s*\(talk.*$/i,'')
            .trim();
}

function extractNomination(section){
    debug('extractNomination start', section.get(0));

    const h4 = section.is('h4') ? section : section.children('h4').first();
    let user=extractUserFromHeading(h4);

    let content=section.is('h4')
        ? section.nextUntil('h4')
        : section.nextUntil('.mw-heading4');

    let article='';
    let articleLine=content.filter(function(){
        return /^Article:\s*/i.test($(this).text().trim()) || $(this).text().includes('Article:');
    }).first();

    if(!articleLine.length){
        articleLine=content.find('b:contains("Article:")').first().parent();
    }

    let articleData=firstArticleLinkData(articleLine);
    article=articleData.title;

    if(!article){
        articleData=firstArticleLinkData(content);
        article=articleData.title;
    }

    let data=$.extend({user, article, articleDisplay: articleData.display}, findNominationLinkData(content));
    debug('extractNomination result', data);
    return data;
}

function extractNominationFromArticleLine(articleLine){
    let p=$(articleLine);
    debug('extractNominationFromArticleLine start', {
        text: p.text().trim(),
        element: articleLine
    });
    let heading=p.prevAll('.mw-heading4, h4').first();
    let h4=heading.is('h4') ? heading : heading.find('h4').first();
    let content=p.add(p.nextUntil('.mw-heading4, h4'));
    let user=extractUserFromHeading(h4);

    let result={
        heading,
        h4,
        data:(function(){
            let articleData=firstArticleLinkData(p);
            if(!articleData.title){
                articleData=firstArticleLinkData(content);
            }
            return $.extend({
                user,
                article:articleData.title,
                articleDisplay:articleData.display
            }, findNominationLinkData(content));
        })()
    };
    debug('extractNominationFromArticleLine result', {
        headingFound: !!heading.length,
        h4Found: !!h4.length,
        headingText: h4.text().trim(),
        data: result.data
    });
    return result;
}

/* ================= UI ================= */

async function openDialog(data){
    debug('openDialog start', data);

    const mount=document.body.appendChild(document.createElement('div'));
    const { Vue, CdxDialog, CdxButton, CdxTextInput, CdxTextArea, CdxCheckbox, CdxField }=await loadCodex();

    Vue.createMwApp({
        components:{
            'cdx-dialog': CdxDialog,
            'cdx-button': CdxButton,
            'cdx-text-input': CdxTextInput,
            'cdx-text-area': CdxTextArea,
            'cdx-checkbox': CdxCheckbox,
            'cdx-field': CdxField
        },

        data(){
            return{
                open:true,
                isRunning:false,
                isPreviewLoading:false,
                user:data.user,
                article:data.article,
                articleDisplay:data.articleDisplay || '',
                notifyUserEnabled:true,
                logActionEnabled:true,
                customMessage:'',
                declineReason:'',
                previewMode:'approval',
                previewHtml:'',
                previewError:'',
                userAwardCount:1,
                creationDate:'',
                dykDate:'',
                gaDate:'',
                faDate:'',
                awardDate:today()
            };
        },

        computed:{
            recordPreview(){ return buildRow(this, this.userAwardCount); },
            approvalNoticeWikitext(){ return buildTalkText(this.article, this.customMessage); },
            declineNoticeWikitext(){ return buildDeclineTalkText(this.article, this.declineReason); },
            selectedNoticeWikitext(){
                return this.previewMode === 'decline'
                    ? this.declineNoticeWikitext
                    : this.approvalNoticeWikitext;
            },
            selectedNoticeTitle(){
                return this.previewMode === 'decline'
                    ? 'Decline notice preview'
                    : 'Approval notice preview';
            },
            selectedSectionTitle(){
                return this.previewMode === 'decline'
                    ? 'Four Award nomination for ' + this.article
                    : 'Four Award for ' + this.article;
            },
            selectedPreviewPageTitle(){
                return 'User talk:' + this.user;
            }
        },

        async mounted(){
            debug('dialog mounted', {
                user:this.user,
                article:this.article,
                rawDyk:data.dyk,
                rawGa:data.ga,
                rawFac:data.fac
            });
            try{
                let records=await getWikitext(RECORDS_PAGE);
                this.userAwardCount=getNextCount(records,this.user);
                this.creationDate=await getCreationDate(this.article);
                this.dykDate=parseDYK(data.dyk);
                this.gaDate=await parseGA(data.ga || this.article);
                let fac=await parseFAC(data.fac,this.article);
                this.faDate=fac.date;
                debug('dialog date population complete', {
                    creationDate:this.creationDate,
                    dykDate:this.dykDate,
                    gaDate:this.gaDate,
                    faDate:this.faDate
                });
            }catch(e){
                error('dialog date population failed', e);
                mw.notify('Four Award helper date lookup failed: ' + (e?.message || e), {type:'warn'});
            }
        },

        methods:{
            closeDialog(){
                this.open=false;
                mount.remove();
            },
            async runApprove(){
                if(this.isRunning) return;
                this.isRunning=true;
                try{
                    await approve(this);
                    mw.notify('Four Award approved');
                    this.closeDialog();
                }catch(e){
                    error('runApprove failed', e);
                    mw.notify('Four Award helper failed: ' + (e?.error?.info || e?.message || e), {type:'error'});
                }finally{
                    this.isRunning=false;
                }
            },
            async runDecline(){
                if(this.isRunning) return;
                this.isRunning=true;
                try{
                    await decline(this);
                    mw.notify('Four Award nomination declined');
                    this.closeDialog();
                }catch(e){
                    error('runDecline failed', e);
                    mw.notify('Four Award helper failed: ' + (e?.error?.info || e?.message || e), {type:'error'});
                }finally{
                    this.isRunning=false;
                }
            },
            async refreshPreview(mode){
                if(mode){
                    this.previewMode=mode;
                }
                this.isPreviewLoading=true;
                this.previewError='';
                try{
                    this.previewHtml=await parseWikitext(
                        this.selectedPreviewPageTitle,
                        this.selectedNoticeWikitext,
                        this.selectedSectionTitle
                    );
                    this.$nextTick(function(){
                        $(mount).find('.four-award-helper-preview a').attr('target','_blank');
                    });
                }catch(e){
                    error('refreshPreview failed', e);
                    this.previewHtml='';
                    this.previewError=e?.error?.info || e?.message || String(e);
                }finally{
                    this.isPreviewLoading=false;
                }
            }
        },

template:`
<cdx-dialog v-model:open="open" title="Four Award">

<cdx-field>
    <template #label>User</template>
    <cdx-text-input v-model="user" aria-label="User" placeholder="Username"></cdx-text-input>
</cdx-field>
<cdx-field>
    <template #label>Article</template>
    <cdx-text-input v-model="article" aria-label="Article" placeholder="Article title"></cdx-text-input>
</cdx-field>
<cdx-field>
    <template #label>Article display text</template>
    <cdx-text-input v-model="articleDisplay" aria-label="Article display text" placeholder="Optional display text"></cdx-text-input>
</cdx-field>

<cdx-field>
    <template #label>Award date</template>
    <cdx-text-input v-model="awardDate" aria-label="Award date" placeholder="YYYY-MM-DD"></cdx-text-input>
</cdx-field>
<cdx-field>
    <template #label>Creation date</template>
    <cdx-text-input v-model="creationDate" aria-label="Creation date" placeholder="YYYY-MM-DD"></cdx-text-input>
</cdx-field>
<cdx-field>
    <template #label>DYK date</template>
    <cdx-text-input v-model="dykDate" aria-label="DYK date" placeholder="YYYY-MM-DD"></cdx-text-input>
</cdx-field>
<cdx-field>
    <template #label>GA date</template>
    <cdx-text-input v-model="gaDate" aria-label="GA date" placeholder="YYYY-MM-DD"></cdx-text-input>
</cdx-field>
<cdx-field>
    <template #label>FA date</template>
    <cdx-text-input v-model="faDate" aria-label="FA date" placeholder="YYYY-MM-DD"></cdx-text-input>
</cdx-field>

<cdx-field>
    <template #label>Custom approval message</template>
    <cdx-text-area v-model="customMessage" rows="4" aria-label="Custom approval message" placeholder="Optional extra message. Wikitext is allowed."></cdx-text-area>
</cdx-field>

<cdx-field>
    <template #label>Decline reason</template>
    <cdx-text-area v-model="declineReason" rows="4" aria-label="Decline reason" placeholder="Required before declining. Wikitext is allowed."></cdx-text-area>
</cdx-field>

<div style="margin-top: 0.75em;">
    <cdx-checkbox v-model="notifyUserEnabled">
        Notify user talk page
    </cdx-checkbox>
    <cdx-checkbox v-model="logActionEnabled">
        Log action to helper log
    </cdx-checkbox>
</div>

<div style="margin-top: 1em;">
    <div style="font-weight: bold; margin-bottom: 0.25em;">Record row preview</div>
    <pre style="white-space: pre-wrap; overflow:auto; max-height: 10em; border: 1px solid #a2a9b1; padding: 0.75em; background: #f8f9fa;">{{recordPreview}}</pre>
</div>

<div style="margin-top: 1em;">
    <div style="display:flex; gap: 0.5em; align-items:center; justify-content: space-between; margin-bottom: 0.5em;">
        <div style="font-weight: bold;">{{selectedNoticeTitle}}</div>
        <div style="display:flex; gap: 0.5em;">
            <cdx-button @click="refreshPreview('approval')" :disabled="isPreviewLoading">Preview approval</cdx-button>
            <cdx-button @click="refreshPreview('decline')" :disabled="isPreviewLoading || !declineReason.trim()">Preview decline</cdx-button>
        </div>
    </div>
    <div v-if="isPreviewLoading" style="border: 1px solid #a2a9b1; padding: 0.75em; background: #f8f9fa;">Loading preview...</div>
    <div v-else-if="previewError" style="border: 1px solid #d33; padding: 0.75em; background: #fee7e6;">{{previewError}}</div>
    <div v-else-if="previewHtml" class="four-award-helper-preview mw-parser-output" style="border: 1px solid #a2a9b1; padding: 0.75em; background: #fff; max-height: 24em; overflow:auto;" v-html="previewHtml"></div>
    <div v-else style="border: 1px solid #a2a9b1; padding: 0.75em; background: #f8f9fa;">Select a preview before posting.</div>
</div>

<div style="display:flex; gap: 0.5em; justify-content: flex-end; margin-top: 1em;">
    <cdx-button @click="runDecline" action="destructive" :disabled="isRunning || !declineReason.trim()">Decline</cdx-button>
    <cdx-button @click="runApprove" action="progressive" weight="primary" :disabled="isRunning">Approve</cdx-button>
</div>

</cdx-dialog>
`
    }).mount(mount);
}

/* ================= INIT ================= */

function initFourAwardHelper($content){
    debug('initFourAwardHelper start', {
        contentLength: $content.length,
        contentTextStart: $content.text().trim().slice(0,120),
        currentLinks: $('.four-award-helper-link').length
    });
    let articleLines=$content.find('.mw-parser-output p, p').filter(function(){
        return /^Article:\s*/i.test($(this).text().trim());
    });
    debug('article lines found', {
        count: articleLines.length,
        lines: articleLines.map(function(){ return $(this).text().trim().slice(0,160); }).get()
    });

    articleLines.each(function(){

        const parsed=extractNominationFromArticleLine(this);
        const data=parsed.data;
        const h4=parsed.h4;

        if(!h4.length){
            warn('skipping article line: no heading found', {data, line: $(this).text().trim()});
            return;
        }
        if(h4.find('.four-award-helper-link').length){
            debug('skipping article line: link already present', h4.text().trim());
            return;
        }

        if(!data.user || !data.article){
            warn('found a nomination but could not extract all data', data, h4.text());
        }

        const btn=$('<a href="#" class="four-award-helper-link"> [4A helper]</a>');
        btn.click(async e=>{
            e.preventDefault();
            try{
                await openDialog(data);
            }catch(err){
                error('openDialog failed', err);
                mw.notify('Four Award helper failed to open: ' + (err?.message || err), {type:'error'});
            }
        });

        h4.append(btn);
        debug('appended [4A]', {heading: h4.text().trim(), data});
    });
    debug('initFourAwardHelper done', {
        finalLinks: $('.four-award-helper-link').length
    });
}

mw.hook('wikipage.content').add(initFourAwardHelper);
$(function(){
    debug('DOM ready callback');
    initFourAwardHelper($('#mw-content-text'));
});
})();
