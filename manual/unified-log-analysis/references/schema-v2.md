# 草稿与命令

schemaVersion为ula/2。guide输出最小JSON。输入：

- question只填restatement；原话、type和problemWindow由start/question在检索前登记，草稿不能覆盖。
- evidence：{id,ref,quote,fields:[{key,raw,norm,rule}]}。ref为search返回的F1:L12#行hash；quote须原行连续子串，8–1600字符。rule为identity/lower/hex/id_punctuation。
- events：{id,title,detail,time:null或{raw},lane,role:main/side/context,evidence:[id]}。时间须来自原行；标题简短业务语言。
- relations：{id,from,to,basis:same_id/same_session/time_order,viaIds:[{key,norm}],evidence:[id]}。same_id须同键同值、值有区分度且非实体/容器；same_session仅同容器；时间关系不证明因果。
- findings：{id,type:fact/inference/gap/caution,text,strength:likely/possible,supports:{evidence:[],events:[],relations:[],queries:[],hypotheses:[]}}。gap还须scope:{scope,filters}和patterns，与至少两种锚定、非冗余的全量零命中literal检索对应。
- hypotheses：{id,statement,status:open/supported/refuted/undetermined,for:[],against:[],queries:[]}。refuted须有效反证。
- diagnosis：{causeStatus:confirmed/likely/possible/undetermined/not_applicable,lastVisible:事件ID,lastVisibleLine:可选证据ID,firstMissing:{expected,queries,scope,patterns},cause:{evidence,explicitReason},insufficiency:[{kind,detail}],suggestions:[{what,where,why}]}。不指定锚行时取末端事件最晚证据。原因未定须lastVisible/firstMissing/insufficiency/suggestions。firstMissing须有效缺失检索。failurePoint、修复轨迹、桥接和披露字段已移除。
- extensions：{名称@版本:{states:[{key,label,value,evidence:[]}]}}，可选。

工具核对原因后写causeAssessment:{ai,checked,reasons}。confirmed要求explicitReason为有效原因引文子串，原因行与锚行同一行或共享可区分的非实体非容器ID；同文件原因不能更晚，跨文件须同一时钟域并可比较。likely须共享ID和带有效反证的已排除假设，并在首次检索前用 `question --problem-window` 登记问题时段，工具自行比较同域模板的问题/其他时段速率。条件不足封顶possible；未登记时采用推定范围，无法做速率对照，也封顶possible。封顶后等级决定是否允许因果措辞。

neighborhood、followups、afterEvents、丢失限定、build和coverage都是工具字段，草稿不能伪造。所有id全局唯一。证据失败会逐层降级；快照或账本被改则拒绝发布。render重新核对当前草稿及被引用的零命中查询。

命令统一为 `python -I -B <技能目录>/scripts/ula.py 命令`。search使用--spec或--spec-file，支持literal/regex/id/trace/lines/time/count/stats/rare/compare/neighborhood；常用参数value、scope(all或{files,segments})、filters、range、max、page。question例：`question --run R --question 原话 --question-type existence`。scan后可segment，render默认清理work，--keep-work保留。
